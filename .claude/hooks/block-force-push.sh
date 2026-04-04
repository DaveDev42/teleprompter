#!/bin/bash
# PreToolUse hook: Block force push to main/master
# Input: JSON on stdin with tool_input.command
# Exit 2 = block, Exit 0 = allow

COMMAND=$(cat | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

if echo "$COMMAND" | grep -qE 'git push.*(--force|--force-with-lease|-f)(\s|$).*\b(main|master)\b|git push.*\b(main|master)\b.*(--force|--force-with-lease|-f)(\s|$)'; then
  echo "BLOCKED: main/master에 대한 force push는 금지되어 있습니다." >&2
  exit 2
fi

exit 0
