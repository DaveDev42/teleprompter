#!/bin/bash
# PreToolUse hook: Block manual version field edits
# Input: JSON on stdin with tool_input (file_path, new_string/content)
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$FILE" in
  # version.txt IS the version (release-type: simple since #5 PR7) and the
  # manifest is release-please's own state — any manual edit is a version edit.
  *version.txt|*.release-please-manifest.json)
    echo "BLOCKED: version 파일(version.txt/.release-please-manifest.json) 수동 편집 금지. Release Please가 자동 관리합니다." >&2
    exit 2
    ;;
  # Any remaining package.json (e.g. a future sub-tool) keeps the field-level
  # guard: block only edits that touch a "version": field.
  *package.json)
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty')
    if echo "$CONTENT" | grep -qE '"version"\s*:'; then
      echo "BLOCKED: version 필드 수동 편집 금지. Release Please가 자동 관리합니다." >&2
      exit 2
    fi
    ;;
esac

exit 0
