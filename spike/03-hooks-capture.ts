/**
 * Spike 3: Claude Code hooks 이벤트 수집
 *
 * 검증 항목:
 * 1. hooks 설정을 .claude/settings.local.json에 추가하면 동작하는가
 * 2. hook 스크립트가 stdin으로 JSON을 받는가
 * 3. 수집한 이벤트를 파일로 저장할 수 있는가
 * 4. async: true로 비차단 수집이 가능한가
 *
 * 사용법:
 *   1. bun run spike/03-hooks-capture.ts setup  (hooks 설정 + 수집 스크립트 생성)
 *   2. claude --print "Say hello"               (Claude Code 실행해서 이벤트 발생)
 *   3. bun run spike/03-hooks-capture.ts check   (수집된 이벤트 확인)
 *   4. bun run spike/03-hooks-capture.ts cleanup  (설정 복원)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";

const projectDir = process.cwd();
const settingsPath = join(projectDir, ".claude", "settings.local.json");
const hooksDir = join(projectDir, "spike", "hooks-output");
const captureScript = join(projectDir, "spike", "capture-hook.sh");

const command = process.argv[2] || "setup";

if (command === "setup") {
  // 1. hooks 출력 디렉토리 생성
  mkdirSync(hooksDir, { recursive: true });

  // 2. 수집 스크립트 생성
  const script = `#!/bin/bash
INPUT=$(cat)
EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
TIMESTAMP=$(date +%s%N)
echo "$INPUT" > "${hooksDir}/\${EVENT_NAME}_\${TIMESTAMP}.json"
exit 0
`;
  writeFileSync(captureScript, script, { mode: 0o755 });
  console.log(`[SETUP] Capture script: ${captureScript}`);

  // 3. .claude/settings.local.json에 hooks 설정 추가
  mkdirSync(join(projectDir, ".claude"), { recursive: true });

  const allEvents = [
    "SessionStart", "SessionEnd",
    "UserPromptSubmit", "Stop", "StopFailure",
    "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "Notification",
    "SubagentStart", "SubagentStop",
    "PreCompact", "PostCompact",
    "Elicitation", "ElicitationResult",
  ];

  const hooks: Record<string, unknown[]> = {};
  for (const event of allEvents) {
    hooks[event] = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: captureScript,
            timeout: 10,
          },
        ],
      },
    ];
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }
  // 기존 설정 백업
  if (settings.hooks) {
    writeFileSync(settingsPath + ".bak", JSON.stringify(settings, null, 2));
    console.log(`[SETUP] Backed up existing settings to ${settingsPath}.bak`);
  }
  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[SETUP] Hooks configured in ${settingsPath}`);
  console.log(`[SETUP] Listening for ${allEvents.length} event types`);
  console.log(`\n[NEXT] Run: claude --print "Say hello in one sentence"`);
  console.log(`[NEXT] Then: bun run spike/03-hooks-capture.ts check`);

} else if (command === "check") {
  if (!existsSync(hooksDir)) {
    console.log("[CHECK] No hooks output directory found");
    process.exit(1);
  }

  const files = readdirSync(hooksDir).filter(f => f.endsWith(".json"));
  console.log(`[CHECK] Captured ${files.length} events:\n`);

  for (const file of files.sort()) {
    const data = JSON.parse(readFileSync(join(hooksDir, file), "utf-8"));
    const eventName = data.hook_event_name || "unknown";
    const sessionId = data.session_id || "?";
    const toolName = data.tool_name || "";
    console.log(`  ${eventName}${toolName ? ` (${toolName})` : ""} [session: ${sessionId.substring(0, 8)}...]`);

    // 주요 필드 표시
    const keys = Object.keys(data).filter(k => !["session_id", "hook_event_name", "transcript_path"].includes(k));
    if (keys.length > 0) {
      console.log(`    fields: ${keys.join(", ")}`);
    }
  }

} else if (command === "cleanup") {
  // settings 복원
  if (existsSync(settingsPath + ".bak")) {
    const backup = readFileSync(settingsPath + ".bak", "utf-8");
    writeFileSync(settingsPath, backup);
    unlinkSync(settingsPath + ".bak");
    console.log("[CLEANUP] Settings restored from backup");
  } else if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    delete settings.hooks;
    if (Object.keys(settings).length === 0) {
      unlinkSync(settingsPath);
      console.log("[CLEANUP] Empty settings file removed");
    } else {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("[CLEANUP] Hooks removed from settings");
    }
  }

  // 수집 파일 정리
  if (existsSync(hooksDir)) {
    const files = readdirSync(hooksDir);
    for (const f of files) unlinkSync(join(hooksDir, f));
    console.log(`[CLEANUP] Removed ${files.length} captured events`);
  }

  if (existsSync(captureScript)) {
    unlinkSync(captureScript);
    console.log("[CLEANUP] Capture script removed");
  }

  console.log("[CLEANUP] Done");
}
