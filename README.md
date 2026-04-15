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
  --secret-string file://blanxlait-agent-manager.pem \
  --profile blanxlait-ai

aws secretsmanager put-secret-value \
  --secret-id github-brain/anthropic-api-key \
  --secret-string "$ANTHROPIC_API_KEY" \
  --profile blanxlait-ai
```

### 4. Configure the GitHub App webhook

In the `blanxlait-agent-manager` App settings:

- **Webhook URL**: `<WebhookUrl output from the CDK stack>`
- **Webhook secret**: same value you put into `github-brain/webhook-secret`
- **Events**: subscribe to `Pull requests` and `Check suites`

## Security notes

- The Lambda includes a short-lived installation token (~1 hour TTL) in the user-message body sent to the Managed Agent. Session events are stored server-side by Anthropic. The token is scoped to one installation and one event, and auto-expires. For v1 this tradeoff is acceptable. A later ship can replace this with an MCP server that mints tokens on demand so the token never crosses the boundary.
- The webhook handler runs with a 10-second timeout to satisfy GitHub's delivery SLA. All downstream work (session execution) happens asynchronously.
