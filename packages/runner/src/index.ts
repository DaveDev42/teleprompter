import { parseArgs } from "util";
import { Runner } from "./runner";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    sid: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    "worktree-path": { type: "string" },
    "socket-path": { type: "string" },
    cols: { type: "string", default: "120" },
    rows: { type: "string", default: "40" },
  },
  allowPositionals: true,
});

const sid = values.sid ?? `session-${Date.now()}`;
const cwd = values.cwd ?? process.cwd();

// Everything after "--" becomes claudeArgs via positionals
const runner = new Runner({
  sid,
  cwd,
  worktreePath: values["worktree-path"],
  socketPath: values["socket-path"],
  cols: Math.max(1, parseInt(values.cols ?? "120", 10) || 120),
  rows: Math.max(1, parseInt(values.rows ?? "40", 10) || 40),
  claudeArgs: positionals,
});

// Graceful shutdown: call runner.stop() so hook receiver socket is removed
// and the 'bye' IPC message is sent before exiting. A second signal while
// stopping forces an immediate exit to avoid hanging forever.
let stopping = false;
function gracefulShutdown(signal: string): void {
  if (stopping) {
    // Second signal — force exit immediately
    process.exit(1);
  }
  stopping = true;
  runner.stop(signal === "SIGINT" ? 130 : 143);
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

try {
  await runner.start();
} catch (err) {
  console.error("[Runner] fatal:", err);
  process.exit(1);
}
