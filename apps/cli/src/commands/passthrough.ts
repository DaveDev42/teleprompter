/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Starts a daemon + runner in-process, spawning claude with all non-tp args.
 * This is the default mode when no subcommand is given.
 */
import { Daemon, SessionManager } from "@teleprompter/daemon";
import { splitArgs } from "../args";
import { resolveRunnerCommand } from "../spawn";

export async function passthroughCommand(argv: string[]): Promise<void> {
  const { tpArgs, claudeArgs } = splitArgs(argv);

  const sid = tpArgs.sid ?? `session-${Date.now()}`;
  const cwd = tpArgs.cwd ?? process.cwd();
  const wsPort = parseInt(tpArgs.wsPort ?? "7080", 10);

  // Inject self-spawn runner command
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const daemon = new Daemon();
  const socketPath = daemon.start();
  daemon.startWs(wsPort);

  // Spawn runner with claude args
  daemon.createSession(sid, cwd, { claudeArgs });

  function shutdown() {
    daemon.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for the runner process to exit
  const runner = daemon.getRunner(sid);
  if (runner?.process) {
    const exitCode = await runner.process.exited;
    daemon.stop();
    process.exit(exitCode);
  }
}
