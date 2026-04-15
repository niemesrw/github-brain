# agent

Managed Agent definition — the system prompt and a one-time setup script.

## Files

- **`system-prompt.md`** — the agent's system prompt. Decision rules, guardrails, and the `RESULT:` reporting contract.
- **`setup.sh`** — one-time: creates the Managed Agent and Environment via the Anthropic API and prints their IDs.

## Setup (one time)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./agent/setup.sh
```

Copy the printed `AGENT_ID` and `ENVIRONMENT_ID` into repo variables:

```bash
gh variable set AGENT_ID       --body <id> --repo niemesrw/github-brain
gh variable set ENVIRONMENT_ID --body <id> --repo niemesrw/github-brain
```

The deploy workflow reads these at CDK synth time and bakes them into the Lambda environment.

## Updating the system prompt

Managed Agents are versioned. To update the prompt, re-create the agent (or use the update API) and update the `AGENT_ID` variable.

## Scope (v1)

The agent handles one event per session. The Lambda dispatches only Dependabot PR activity on `niemesrw/openbrain` — everything else is filtered out before the session is created. See `../cdk/lambda/handler.ts`.
