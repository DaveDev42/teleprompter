#!/bin/bash
# SubagentStop hook: Validate QA agent results for tool call evidence
# Input: JSON on stdin with subagent context
# Outputs systemMessage warning if QA PASS lacks evidence

INPUT=$(cat)

# Extract subagent type and result
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // empty')
RESULT=$(echo "$INPUT" | jq -r '.result // empty')

# Only validate app-web-qa (app-mobile-qa is handled by expo-mcp plugin hook)
case "$SUBAGENT_TYPE" in
  app-web-qa) ;;
  *) exit 0 ;;
esac

# Check if result contains PASS verdict
if ! echo "$RESULT" | grep -qiE '판정.*PASS|PASS'; then
  # Not a PASS result, no validation needed
  exit 0
fi

# Check for required tool call evidence based on agent type
MISSING=()

case "$SUBAGENT_TYPE" in
  app-web-qa)
    # App launch evidence (MCP navigate or Playwright test execution)
    if ! echo "$RESULT" | grep -qiE 'browser_navigate|playwright test'; then
      MISSING+=("앱 실행 도구 호출")
    fi
    # UI verification evidence
    if ! echo "$RESULT" | grep -qiE 'browser_snapshot|browser_take_screenshot|playwright test'; then
      MISSING+=("UI 확인 도구 호출")
    fi
    # Interaction evidence
    if ! echo "$RESULT" | grep -qiE 'browser_click|browser_type|browser_press_key|browser_select_option|browser_evaluate|browser_hover|playwright test'; then
      MISSING+=("실제 인터랙션 도구 호출")
    fi
    ;;
esac

if [ ${#MISSING[@]} -gt 0 ]; then
  MISSING_LIST=$(printf ", %s" "${MISSING[@]}")
  MISSING_LIST=${MISSING_LIST:2}

  jq -n --arg msg "⚠️ QA 검증 경고: 이 QA PASS 결과에 다음 증거가 누락되었습니다: ${MISSING_LIST}. INVALID 판정을 고려하고, 필요시 QA agent에게 재위임하세요." \
    '{ "systemMessage": $msg }'
  exit 0
fi

exit 0
