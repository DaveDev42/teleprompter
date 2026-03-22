/**
 * Spike 4: --settings 플래그로 hooks 주입
 *
 * 검증 항목:
 * 1. --settings로 hooks를 CLI에서 주입할 수 있는가
 * 2. settings.local.json 수정 없이 동작하는가
 *
 * 사용법: bun run spike/04-hooks-via-settings.ts
 */

import { mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const hooksDir = join(process.cwd(), "spike", "hooks-output-2");
mkdirSync(hooksDir, { recursive: true });

// 캡처 스크립트를 인라인으로 생성
const captureScript = join(process.cwd(), "spike", "capture-hook-2.sh");
await Bun.write(captureScript, `#!/bin/bash
INPUT=$(cat)
EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
TIMESTAMP=$(date +%s%N)
echo "$INPUT" > "${hooksDir}/\${EVENT_NAME}_\${TIMESTAMP}.json"
exit 0
`);
await Bun.$`chmod +x ${captureScript}`;

// --settings로 전달할 JSON
const allEvents = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop",
  "PreToolUse", "PostToolUse", "Notification",
];

const hooks: Record<string, unknown[]> = {};
for (const event of allEvents) {
  hooks[event] = [{
    matcher: "",
    hooks: [{ type: "command", command: captureScript, timeout: 10 }],
  }];
}

const settingsJson = JSON.stringify({ hooks });
console.log(`[SPIKE] Settings JSON length: ${settingsJson.length}`);
console.log(`[SPIKE] Running: claude --print --settings '<json>' "Say hello"`);

// --settings로 hooks 주입
const proc = Bun.spawn(
  ["claude", "--print", "--settings", settingsJson, "Say hello in one sentence"],
  { stdout: "pipe", stderr: "pipe" }
);

const output = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

console.log(`[SPIKE] Exit code: ${exitCode}`);
console.log(`[SPIKE] Output: ${output.trim()}`);
if (stderr) console.log(`[SPIKE] Stderr: ${stderr.trim()}`);

// 캡처된 이벤트 확인
await Bun.sleep(500); // hook async 완료 대기

if (existsSync(hooksDir)) {
  const files = readdirSync(hooksDir).filter(f => f.endsWith(".json"));
  console.log(`\n[RESULT] Captured ${files.length} events via --settings:`);
  for (const file of files.sort()) {
    const data = JSON.parse(readFileSync(join(hooksDir, file), "utf-8"));
    console.log(`  ${data.hook_event_name}${data.tool_name ? ` (${data.tool_name})` : ""}`);
  }

  if (files.length > 0) {
    console.log("\n[SPIKE] ✓ --settings hooks injection WORKS");
  } else {
    console.log("\n[SPIKE] ✗ No events captured");
  }
}

// 정리
await Bun.$`rm -rf ${hooksDir} ${captureScript}`;
