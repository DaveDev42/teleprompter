import { parseArgs } from "util";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import { resolveRunnerCommand } from "../spawn";

export async function daemonCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  if (subcommand !== "start") {
    console.error(`Usage: tp daemon start [--ws-port 7080] [--spawn --sid X --cwd Y]`);
    process.exit(1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      spawn: { type: "boolean", default: false },
      sid: { type: "string" },
      cwd: { type: "string" },
      "worktree-path": { type: "string" },
      "ws-port": { type: "string", default: "7080" },
    },
    strict: false,
  });

  // Inject self-spawn runner command so SessionManager uses `tp run` instead of relative path
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const daemon = new Daemon();
  const socketPath = daemon.start();

  const wsPort = parseInt(values["ws-port"] as string, 10);
  daemon.startWs(wsPort);

  console.log(`[Daemon] listening on ${socketPath}`);
  console.log("[Daemon] press Ctrl+C to stop");

  if (values.spawn) {
    const sid = (values.sid as string) ?? `session-${Date.now()}`;
    const cwd = (values.cwd as string) ?? process.cwd();
    daemon.createSession(sid, cwd, {
      worktreePath: values["worktree-path"] as string | undefined,
    });
  }

  function shutdown() {
    console.log("\n[Daemon] shutting down...");
    daemon.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
