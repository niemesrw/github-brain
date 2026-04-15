# agent

Managed Agent definition — just the system prompt.

## Files

- **`system-prompt.md`** — decision rules, guardrails, and the `RESULT:` reporting contract.

## Setup (one time)

Create the agent and environment in the Claude console:

👉 https://platform.claude.com/workspaces/default/agent-quickstart

Settings:

- **Agent name**: `github-brain`
- **Model**: `claude-sonnet-4-6`
- **System prompt**: paste contents of [`system-prompt.md`](./system-prompt.md)
- **Tools**: enable the default agent toolset (`agent_toolset_20260401` — bash, file ops, web)
- **Environment**: cloud, networking `unrestricted`

Copy the Agent ID and Environment ID, then set them as GitHub repo variables:

```bash
gh variable set AGENT_ID       --body <id> --repo niemesrw/github-brain
gh variable set ENVIRONMENT_ID --body <id> --repo niemesrw/github-brain
```

## Updating the system prompt

Managed Agents are versioned. Edit in the console (or via API) and update `AGENT_ID` if a new version creates a new ID.

## Scope (v1)

One event per session. The Lambda dispatches only Dependabot PR activity on `niemesrw/openbrain` — see `../cdk/lambda/handler.ts`.
