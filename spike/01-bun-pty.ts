/**
 * Spike 1: Bun PTY로 Claude Code 실행
 *
 * 검증 항목:
 * 1. Claude Code가 TTY로 인식하는가 (색상, 커서, 인터랙티브 모드)
 * 2. terminal.write()로 입력이 전달되는가
 * 3. PTY 종료가 정상 처리되는가
 *
 * 사용법: bun run spike/01-bun-pty.ts
 */

const proc = Bun.spawn(["claude", "--print", "Say hello in one sentence"], {
  terminal: {
    cols: 120,
    rows: 40,
    name: "xterm-256color",
    data: (_term, data) => {
      const text = Buffer.from(data).toString("utf-8");
      process.stdout.write(`[PTY OUT] ${text}`);
    },
  },
});

console.log(`[SPIKE] Claude Code spawned, PID: ${proc.pid}`);
console.log(`[SPIKE] Waiting for exit...`);

const exitCode = await proc.exited;
console.log(`\n[SPIKE] Claude Code exited with code: ${exitCode}`);
