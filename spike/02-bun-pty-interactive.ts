/**
 * Spike 2: Bun PTY 인터랙티브 모드 + terminal.write() 입력
 *
 * 타이밍 기반 접근: Claude Code 시작 후 5초 대기 → 입력 전송 → 응답 대기 → /exit
 *
 * 사용법: bun run spike/02-bun-pty-interactive.ts
 */

let allOutput = "";

const proc = Bun.spawn(["claude"], {
  terminal: {
    cols: 120,
    rows: 40,
    name: "xterm-256color",
    data: (_term, data) => {
      const text = Buffer.from(data).toString("utf-8");
      allOutput += text;
      process.stdout.write(text);
    },
  },
});

console.log(`[SPIKE] PID: ${proc.pid}, waiting 5s for Claude Code to initialize...`);

// 5초 후 입력 전송
await Bun.sleep(5000);
console.log("\n[SPIKE] Sending input via terminal.write()...");
proc.terminal!.write('Say exactly "SPIKE_OK" and nothing else\n');

// 30초간 응답 대기
const start = Date.now();
while (Date.now() - start < 30000) {
  await Bun.sleep(500);
  if (allOutput.includes("SPIKE_OK")) {
    console.log("\n[SPIKE] ✓ Response received! terminal.write() WORKS");
    break;
  }
}

if (!allOutput.includes("SPIKE_OK")) {
  console.log("\n[SPIKE] ✗ No response after 30s");
}

// /exit 전송
console.log("[SPIKE] Sending /exit...");
proc.terminal!.write("/exit\n");

const exitCode = await proc.exited;
console.log(`[SPIKE] Exited with code: ${exitCode}`);
