#!/usr/bin/env bash
# Update an existing Managed Agent's system prompt.
#
# Managed Agents are versioned — the ID doesn't change across prompt edits.
# Re-run this any time you edit system-prompt.md.
#
# Requires:
#   ANTHROPIC_API_KEY  Anthropic API key
#   AGENT_ID           existing agent ID (from `gh variable list --repo niemesrw/github-brain`)

set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${AGENT_ID:?AGENT_ID is required}"

HEADERS=(
  -H "x-api-key: $ANTHROPIC_API_KEY"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
  -H "content-type: application/json"
)

SYSTEM_PROMPT=$(cat "$(dirname "$0")/system-prompt.md")

echo "Updating agent $AGENT_ID..."
result=$(curl -sS --fail-with-body -X POST "https://api.anthropic.com/v1/agents/$AGENT_ID" "${HEADERS[@]}" \
  -d "$(jq -n \
    --arg system "$SYSTEM_PROMPT" \
    '{system: $system}')")

version=$(jq -er '.version' <<<"$result")
echo "Updated. New version: $version"
