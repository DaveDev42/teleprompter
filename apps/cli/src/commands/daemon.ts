import {
  checkDaemonLockAlive,
  Daemon,
  getDaemonLockPath,
  SessionManager,
} from "@teleprompter/daemon";
import { setLogLevel } from "@teleprompter/protocol";
import { parseArgs } from "util";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { resolveRunnerCommand } from "../spawn";

export async function daemonCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  switch (subcommand) {
    case "start":
      break; // fall through to existing start logic
    case "stop":
      return daemonStop();
    case "install": {
      const { installService } = await import("../lib/service");
      return installService();
    }
    case "uninstall": {
      const { uninstallService } = await import("../lib/service");
      return uninstallService();
    }
    case "status": {
      const { daemonStatusCommand } = await import("./daemon-status");
      return daemonStatusCommand(argv.slice(1));
    }
    default:
      console.error(
        `Usage: tp daemon <start|stop|status|install|uninstall> [options]\n` +
          `  start      Start daemon in foreground\n` +
          `  stop       Stop the running daemon\n` +
          `  status     Show service registration + running state\n` +
          `  install    Register as OS service (launchd/systemd/Task Scheduler)\n` +
          `  uninstall  Remove OS service registration`,
      );
      process.exit(1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      spawn: { type: "boolean", default: false },
      sid: { type: "string" },
      cwd: { type: "string" },
      "worktree-path": { type: "string" },
      "repo-root": { type: "string" },
      "prune-ttl": { type: "string" },
      "no-prune": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
    },
    strict: false,
  });

  // Set log level
  if (values.verbose) setLogLevel("debug");
  else if (values.quiet) setLogLevel("error");

  // Inject self-spawn runner command so SessionManager uses `tp run` instead of relative path
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  // Fast path: check pid lock before the slower IPC socket probe.
  // The authoritative singleton guard is in packages/daemon/src/index.ts which
  // holds the lock for its full lifetime. This check prevents the CLI from
  // spawning a second daemon when it's already running.
  const lockPid = checkDaemonLockAlive(getDaemonLockPath());
  if (lockPid !== null) {
    console.log(`[Daemon] already running (pid=${lockPid}) — exiting`);
    return;
  }

  if (await isDaemonRunning()) {
    console.log("[Daemon] already running — exiting");
    return;
  }

  const daemon = new Daemon();
  const socketPath = daemon.start();

  // Start auto-cleanup (prune on startup + every 24h)
  if (!values["no-prune"]) {
    const parsed = values["prune-ttl"]
      ? parseInt(values["prune-ttl"] as string, 10)
      : undefined;
    const ttlDays =
      parsed !== undefined && Number.isNaN(parsed) ? undefined : parsed;
    daemon.startAutoCleanup(ttlDays);
  }

  // Enable worktree management if repo root is specified
  if (values["repo-root"]) {
    daemon.setRepoRoot(values["repo-root"] as string);
    console.log(
      `[Daemon] worktree management enabled for ${values["repo-root"]}`,
    );
  }

  // Reconnect all saved pairings (store DB is the sole source of truth).
  const count = await daemon.reconnectSavedRelays();
  if (count > 0) {
    console.log(`[Daemon] reconnected to ${count} saved relay(s)`);
  }

  console.log(`[Daemon] listening on ${socketPath}`);
  console.log("[Daemon] press Ctrl+C to stop");

  if (values.spawn) {
    const sid = (values.sid as string) ?? `session-${Date.now()}`;
    const cwd = (values.cwd as string) ?? process.cwd();
    daemon.createSession(sid, cwd, {
      worktreePath: values["worktree-path"] as string | undefined,
    });
  }

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[Daemon] shutting down...");
    daemon.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Auto-restart on crash (--watch mode)
  if (values.watch) {
    process.on("uncaughtException", (err) => {
      console.error("[Daemon] uncaught exception:", err.message);
      console.error("[Daemon] restarting in 3s...");
      daemon.stop();
      setTimeout(() => {
        daemonCommand(argv);
      }, 3000);
    });

    process.on("unhandledRejection", (err: unknown) => {
      console.error(
        "[Daemon] unhandled rejection:",
        err instanceof Error ? err.message : err,
      );
      // Don't restart for rejections — they're usually non-fatal
    });
  }
}

/**
 * Stop the running daemon.
 *
 * On macOS: bootout the launchd service first so launchd doesn't immediately
 * respawn the daemon after we SIGTERM it. On Linux: stop the systemd unit first.
 * Then send SIGTERM to the running pid (read from the pid lock file).
 */
async function daemonStop(): Promise<void> {
  const { platform } = await import("os");
  const os = platform();

  // Step 1: tell the service manager to stop / unload so it won't respawn
  if (os === "darwin") {
    const { isServiceInstalled, getServiceLabel } = await import(
      "../lib/service-darwin"
    );
    if (isServiceInstalled()) {
      const uid = process.getuid?.() ?? 501;
      const label = getServiceLabel();
      // `bootout` removes the job from launchd's registry — no auto-respawn
      const result = Bun.spawnSync([
        "launchctl",
        "bootout",
        `gui/${uid}/${label}`,
      ]);
      if (result.exitCode === 0) {
        console.log(`[Daemon] unloaded launchd service ${label}`);
      }
    }
  } else if (os === "linux") {
    const { isServiceInstalled, getServiceName } = await import(
      "../lib/service-linux"
    );
    if (isServiceInstalled()) {
      const name = getServiceName();
      Bun.spawnSync(["systemctl", "--user", "stop", name]);
      console.log(`[Daemon] stopped systemd unit ${name}`);
    }
  }

  // Step 2: SIGTERM the daemon pid from the lock file
  const lockPath = getDaemonLockPath();
  const { readDaemonLockPid } = await import("@teleprompter/daemon");
  const pid = readDaemonLockPid(lockPath);
  if (pid === null) {
    console.log("[Daemon] no running daemon found (no pid file)");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`[Daemon] sent SIGTERM to pid=${pid}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      console.log(`[Daemon] pid=${pid} is no longer running`);
    } else {
      console.error(
        `[Daemon] failed to send SIGTERM to pid=${pid}: ${(err as Error).message}`,
      );
    }
  }
}
