#!/usr/bin/env bash
# One-time setup: creates the Managed Agent and Environment, prints IDs.
#
# Requires:
#   ANTHROPIC_API_KEY  Anthropic API key
#
# Outputs:
#   AGENT_ID and ENVIRONMENT_ID — store these as GitHub Actions variables
#   on BLANXLAIT/github-brain so CDK synth can read them from env.

set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"

HEADERS=(
  -H "x-api-key: $ANTHROPIC_API_KEY"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
  -H "content-type: application/json"
)

SYSTEM_PROMPT=$(cat "$(dirname "$0")/system-prompt.md")

echo "Creating agent..."
agent=$(curl -sS --fail-with-body https://api.anthropic.com/v1/agents "${HEADERS[@]}" \
  -d "$(jq -n \
    --arg name "github-brain" \
    --arg model "claude-sonnet-4-6" \
    --arg system "$SYSTEM_PROMPT" \
    '{
      name: $name,
      model: $model,
      system: $system,
      tools: [{type: "agent_toolset_20260401"}]
    }')")

AGENT_ID=$(jq -er '.id' <<<"$agent")
echo "AGENT_ID=$AGENT_ID"

echo "Creating environment..."
environment=$(curl -sS --fail-with-body https://api.anthropic.com/v1/environments "${HEADERS[@]}" \
  -d '{
    "name": "github-brain-env",
    "config": {
      "type": "cloud",
      "networking": {"type": "unrestricted"}
    }
  }')

ENVIRONMENT_ID=$(jq -er '.id' <<<"$environment")
echo "ENVIRONMENT_ID=$ENVIRONMENT_ID"

echo ""
echo "Set these as GitHub Actions variables (not secrets) on BLANXLAIT/github-brain:"
echo "  gh variable set AGENT_ID       --body $AGENT_ID       --repo BLANXLAIT/github-brain"
echo "  gh variable set ENVIRONMENT_ID --body $ENVIRONMENT_ID --repo BLANXLAIT/github-brain"
