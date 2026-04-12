import { createLogger } from "@teleprompter/protocol";
import { parseArgs } from "util";
import { Daemon } from "./daemon";

const log = createLogger("Daemon");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    spawn: { type: "boolean", default: false },
    sid: { type: "string" },
    cwd: { type: "string" },
    "worktree-path": { type: "string" },
  },
  strict: false,
});

const daemon = new Daemon();
const socketPath = daemon.start();

// Auto-cleanup old sessions on startup + every 24h
daemon.startAutoCleanup();

log.info(`listening on ${socketPath}`);
log.info("press Ctrl+C to stop");

// If --spawn is provided, create a session immediately
if (values.spawn) {
  const sid = (values.sid as string) ?? `session-${Date.now()}`;
  const cwd = (values.cwd as string) ?? process.cwd();
  daemon.createSession(sid, cwd, {
    worktreePath: values["worktree-path"] as string | undefined,
  });
}

function shutdown() {
  log.info("shutting down...");
  daemon.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
