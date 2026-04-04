#!/bin/bash
# PreToolUse hook: Block manual version field edits
# Input: JSON on stdin with tool_input (file_path, new_string/content)
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$FILE" in
  *package.json|*app.json|*.release-please-manifest.json)
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty')
    if echo "$CONTENT" | grep -qE '"version"\s*:'; then
      echo "BLOCKED: version 필드 수동 편집 금지. Release Please가 자동 관리합니다." >&2
      exit 2
    fi
    ;;
esac

exit 0
