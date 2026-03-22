#!/bin/bash
# PreToolUse hook: Block --no-verify flag in git commands
# Input: JSON on stdin with tool_input.command
# Exit 2 = block, Exit 0 = allow

COMMAND=$(cat | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

if echo "$COMMAND" | grep -qE '\-\-no-verify'; then
  echo "BLOCKED: --no-verify 플래그 사용이 금지되어 있습니다. pre-commit hook을 건너뛰지 마세요." >&2
  exit 2
fi

exit 0
