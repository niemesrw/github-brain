# github-brain

A GitHub App backed by a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview).

The App receives webhooks; a Lambda in AWS verifies them and starts a Managed Agent session; the agent then acts on the repo using the App's own installation tokens.

## Architecture

```
GitHub event
     │
     ▼  (App-signed webhook)
API Gateway ──▶ Lambda (HMAC verify + event filter)
                   │
                   ▼
           Managed Agent session
                   │
                   ├── mint installation token (as the App)
                   ├── gh CLI + Octokit
                   └── Open Brain memory
```

## Status

Ship #1 in progress: **Dependabot patch auto-merge** on `niemesrw/openbrain`.
Scope is deliberately tiny — one repo, one event shape — so the architecture gets proven before scope widens.

Later ships (not yet built):
- Event-driven issue triage + PR review
- Repo bootstrapping PRs (missing `claude.yml` / `CLAUDE.md`)
- Release notes drafting

## Layout

```
cdk/       CDK stack: API Gateway + Lambda webhook receiver
agent/     Managed Agent system prompt + tool definitions
.github/   Deploy workflow (OIDC → AI account)
```

## Accounts

Deploys to the `blanxlait-ai` AWS account (`057122451218`, `us-east-1`).

## Setup

One-time steps to bring this up from scratch.

### 1. Create the Managed Agent + Environment

Grab an Anthropic API key from the console (the same place the [agent quickstart](https://platform.claude.com/workspaces/default/agent-quickstart) lives if you'd rather click through a UI), then run the setup script:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./agent/setup.sh
```

Save the printed IDs as GitHub repo variables (not secrets):

```bash
gh variable set AGENT_ID       --body <id> --repo niemesrw/github-brain
gh variable set ENVIRONMENT_ID --body <id> --repo niemesrw/github-brain
gh variable set GH_APP_ID      --body <app id>       --repo niemesrw/github-brain
gh variable set GH_INSTALLATION_ID_OPENBRAIN --body <installation id> --repo niemesrw/github-brain
```

### 2. Deploy the stack

The `deploy` workflow runs on push to `main` when `cdk/**` changes, or on manual dispatch. It uses OIDC → management account → chain to AI account.

### 3. Populate secrets

The stack creates three empty secrets in AWS Secrets Manager. Populate them manually (using your `blanxlait-ai` SSO profile):

```bash
aws secretsmanager put-secret-value \
  --secret-id github-brain/webhook-secret \
  --secret-string "$(openssl rand -hex 32)" \
  --profile blanxlait-ai

aws secretsmanager put-secret-value \
  --secret-id github-brain/app-private-key \
  --secret-string file://gh-brain.pem \
  --profile blanxlait-ai

aws secretsmanager put-secret-value \
  --secret-id github-brain/anthropic-api-key \
  --secret-string "$ANTHROPIC_API_KEY" \
  --profile blanxlait-ai
```

### 4. Create + configure the GitHub App

Create a new GitHub App under your personal account (not an org — any personal account can create Apps):

👉 https://github.com/settings/apps/new

Settings:

- **Name**: `gh-brain` (GitHub reserves the `github-` prefix for App slugs, so the repo is `github-brain` but the App slug can't start with that)
- **Homepage URL**: `https://github.com/niemesrw/github-brain`
- **Webhook URL**: `<WebhookUrl output from the CDK stack>`
- **Webhook secret**: same value you put into `github-brain/webhook-secret`
- **Permissions** (repository):
  - Pull requests: Read & Write
  - Checks: Read-only
  - Issues: Read & Write
  - Contents: Read-only
  - Metadata: Read-only (auto)
- **Subscribe to events**: `Pull request`, `Check suite`
- **Where can this App be installed**: Only on this account

After creation:

1. Generate a private key (download the `.pem`) — this goes into `github-brain/app-private-key`.
2. Install the App on `niemesrw/openbrain`.
3. Grab the **App ID** (top of the App settings page) and the **installation ID** (in the URL when you click into the installation). Set both as repo variables:

```bash
gh variable set GH_APP_ID      --body <app id>          --repo niemesrw/github-brain
gh variable set GH_INSTALLATION_ID_OPENBRAIN --body <installation id> --repo niemesrw/github-brain
```

## Observability

**Lambda logs** (every webhook, including filtered-out deliveries):

```bash
FN=$(aws lambda list-functions --profile blanxlait-ai --region us-east-1 \
  --query "Functions[?starts_with(FunctionName, 'GithubBrainWebhook')].FunctionName | [0]" \
  --output text)
aws logs tail /aws/lambda/$FN --follow --profile blanxlait-ai --region us-east-1
```

Every delivery emits one line — either a dispatch (`session dispatched`) or a filter reason (`ignored: not dependabot`, `ignored: repo not in allowlist`, etc.) — with the GitHub delivery ID so you can cross-reference against the App's "Recent Deliveries" tab.

**Managed Agent sessions**: visible in the Claude console at https://platform.claude.com/workspaces/default/sessions. Each dispatch creates a session titled `<event> <action>: <repo>#<pr>`.

**App-side deliveries**: https://github.com/settings/apps/gh-brain/advanced — full request/response history with replay button.

## Security notes

- The Lambda includes a short-lived installation token (~1 hour TTL) in the user-message body sent to the Managed Agent. Session events are stored server-side by Anthropic. The token is scoped to one installation and one event, and auto-expires. For v1 this tradeoff is acceptable. A later ship can replace this with an MCP server that mints tokens on demand so the token never crosses the boundary.
- The webhook handler runs with a 10-second timeout to satisfy GitHub's delivery SLA. All downstream work (session execution) happens asynchronously.
