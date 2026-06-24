import { Runner } from "@teleprompter/runner";
import { parseArgs } from "util";

export async function runCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
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

  const worktreePath = values["worktree-path"];
  const socketPath = values["socket-path"];
  // The Runner constructor validates the sid (rejecting path-traversal
  // sequences), so a bad --tp-sid throws here, before start()'s try/catch —
  // wrap it so the user gets a clean fatal instead of an unhandled stack trace.
  let runner: Runner;
  try {
    runner = new Runner({
      sid,
      cwd,
      ...(worktreePath !== undefined && { worktreePath }),
      ...(socketPath !== undefined && { socketPath }),
      cols: Math.max(1, parseInt(values.cols ?? "120", 10) || 120),
      rows: Math.max(1, parseInt(values.rows ?? "40", 10) || 40),
      claudeArgs: positionals,
    });
  } catch (err) {
    console.error("[Runner] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Graceful shutdown: call runner.stop() so hook receiver socket is removed
  // and the 'bye' IPC message is sent before exiting. A second signal while
  // stopping forces an immediate exit to avoid hanging forever.
  //
  // runner.stop() enqueues the 'bye' frame on the IPC QueuedWriter and calls
  // socket.end(); a synchronous process.exit(0) right after would tear the
  // process down before the event loop flushes that pending write, losing the
  // bye under backpressure. Yield one macrotask (setImmediate) so the queued
  // frame drains before exiting. (`tp run` is the real daemon-spawned runner
  // path, so this — not packages/runner/index.ts — is the dogfood shutdown.)
  let stopping = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (stopping) {
      // Second signal — force exit immediately
      process.exit(1);
    }
    stopping = true;
    runner.stop(signal === "SIGINT" ? 130 : 143);
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.exit(0);
  }

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  try {
    await runner.start();
  } catch (err) {
    console.error("[Runner] fatal:", err);
    process.exit(1);
  }
}
