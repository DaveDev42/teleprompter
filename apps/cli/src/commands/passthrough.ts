/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Runs claude via a Runner connected to a Daemon. PTY output pipes to
 * the local terminal; stdin pipes to the runner. Two paths:
 *
 * 1. SERVICE DAEMON PATH (default when service daemon is running):
 *    The runner connects to the already-running service daemon, which
 *    holds the phone's session keys and can fan out records to paired
 *    frontends via its existing RelayClient. Local stdin is forwarded
 *    via IPC `input`/`resize` messages. Local stdout is served by
 *    polling the shared SQLite session DB (WAL mode — safe for
 *    concurrent readers). This is the fix for paired phones showing a
 *    blank Terminal/Chat in passthrough mode.
 *
 * 2. IN-PROCESS DAEMON PATH (fallback when no service daemon exists):
 *    Spins up an ephemeral in-process Daemon on a temp IPC socket,
 *    reconnects saved relay pairings, and wires onRecord → stdout.
 *    Local stdin and resize forward directly via Daemon.sendInput /
 *    Daemon.resizeSession. This path remains for environments without
 *    a background service (e.g. first run before daemon install).
 *
 * On first run, shows a pairing QR and auto-installs the daemon service.
 */

import { Daemon, SessionManager, Store } from "@teleprompter/daemon";
import { getSocketPath, setLogLevel } from "@teleprompter/protocol";
import { unlinkSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { splitArgs } from "../args";
import { bold, cyan, dim } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { errorWithHints } from "../lib/format";
import { connectIpcAsClient } from "../lib/ipc-client";
import { getConfigDir } from "../lib/paths";
import { resolveRunnerCommand } from "../spawn";

const CONFIG_DIR = getConfigDir();
const INIT_MARKER = join(CONFIG_DIR, ".tp-initialized");

export async function passthroughCommand(argv: string[]): Promise<void> {
  // Check claude CLI exists
  const check = Bun.spawnSync(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.error(
      errorWithHints("Claude Code CLI not found.", [
        "Install: https://docs.anthropic.com/en/docs/claude-code",
        "Or: npm install -g @anthropic-ai/claude-code",
      ]),
    );
    process.exit(1);
  }

  // First-run: pair + install daemon service
  await showFirstRunPairing();

  const { tpArgs, claudeArgs } = splitArgs(argv);
  const sid = tpArgs.sid ?? `session-${Date.now()}`;
  const cwd = tpArgs.cwd ?? process.cwd();

  // Silence all teleprompter logs — PTY owns the terminal.
  process.env.LOG_LEVEL = "silent";
  setLogLevel("silent");

  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const serviceDaemonRunning = await isDaemonRunning();

  if (serviceDaemonRunning) {
    await passthroughViaServiceDaemon(sid, cwd, claudeArgs);
  } else {
    await passthroughViaEphemeralDaemon(sid, cwd, claudeArgs);
  }
}

/**
 * Route the session through the already-running service daemon.
 *
 * The runner's `hello` / `rec` / `bye` all go to the service daemon,
 * which already holds the phone's E2EE session keys and will fan records
 * out via its existing RelayClient. Local PTY output is served by polling
 * the shared Store SQLite (WAL mode — safe concurrent read). Local stdin
 * and resize are forwarded via IPC `input` / `resize` messages to the
 * service daemon, which routes them to the runner (see command-dispatcher.ts
 * `case "input"` / `case "resize"` handling added for this path).
 */
async function passthroughViaServiceDaemon(
  sid: string,
  cwd: string,
  claudeArgs: string[],
): Promise<void> {
  const serviceSockPath = getSocketPath();

  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  // Spawn the runner pointed at the service daemon socket.
  const sessionManager = new SessionManager();
  const proc = sessionManager.spawnRunner(sid, cwd, {
    socketPath: serviceSockPath,
    claudeArgs,
    cols,
    rows,
  });

  // Open the shared Store for reading io records (WAL mode — safe concurrent read).
  const store = new Store();

  // Connect to the service daemon IPC socket to forward stdin/resize.
  let ipc: Awaited<ReturnType<typeof connectIpcAsClient>> | null = null;
  try {
    ipc = await connectIpcAsClient(serviceSockPath);
  } catch {
    // Non-fatal: stdin won't be forwarded but the session still runs
    // (useful for non-interactive -p / --print mode invocations).
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    if (pollTimer) clearInterval(pollTimer);
    proc.kill();
    try {
      ipc?.close();
    } catch {}
    store.close();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // Poll the session db for new io records and pipe to local stdout.
  // Poll at 50 ms — low enough for a responsive terminal, cheap given
  // SQLite WAL reads are O(new records). The session db is created by
  // the service daemon on `hello` from the runner; we retry on each
  // tick until it appears.
  let lastSeq = 0;
  const poll = () => {
    const db = store.getSessionDb(sid);
    if (!db) return; // runner hasn't sent hello yet
    const recs = db.getRecordsFrom(lastSeq, 1000);
    for (const r of recs) {
      if (r.kind === "io") {
        process.stdout.write(Buffer.from(r.payload));
      }
      lastSeq = r.seq;
    }
  };
  pollTimer = setInterval(poll, 50);

  // Forward local stdin → runner PTY via service daemon IPC.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    ipc?.send({
      t: "input",
      sid,
      data: data.toString("base64"),
    });
  });

  // Forward terminal resize → runner PTY via service daemon IPC.
  process.stdout.on("resize", () => {
    ipc?.send({
      t: "resize",
      sid,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
    });
  });

  const exitCode = await proc.exited;
  // Drain any remaining records before exiting so the last output lines
  // are not lost during the 50 ms poll gap.
  poll();
  cleanup();
  process.exit(exitCode);
}

/**
 * Fallback: spin up an ephemeral in-process Daemon on a temp IPC socket.
 *
 * Used when no service daemon is running. The daemon calls
 * `reconnectSavedRelays()` so paired frontends receive frames if the
 * relay is reachable. Local stdout is wired via `daemon.onRecord`.
 *
 * NOTE: This path has a known limitation — the ephemeral daemon's
 * RelayClient starts with an empty `peers` map, so the phone will only
 * receive frames if it re-does key exchange with this new ephemeral
 * daemon during the session (which does not happen automatically). The
 * service-daemon path above fixes this for the typical case. This
 * fallback remains correct for first-run (no service daemon) or
 * environments where the service daemon cannot be started.
 */
async function passthroughViaEphemeralDaemon(
  sid: string,
  cwd: string,
  claudeArgs: string[],
): Promise<void> {
  // Temp IPC socket to avoid colliding with a background daemon service.
  const tmpSocket = join(
    process.env.TMPDIR ?? "/tmp",
    `tp-passthrough-${process.pid}.sock`,
  );

  const daemon = new Daemon();
  daemon.start(tmpSocket);
  // Reconnect saved pairings so the runner's records fan out to the frontend
  // via relay. Without this the relay path is dark and Chat/Terminal stay empty.
  await daemon.reconnectSavedRelays();

  // Pipe runner PTY io records → local stdout
  daemon.onRecord = (_sid, kind, payload) => {
    if (kind === "io") process.stdout.write(payload);
  };

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    daemon.stop();
    try {
      unlinkSync(tmpSocket);
    } catch {}
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    daemon.createSession(sid, cwd, {
      claudeArgs,
      cols,
      rows,
      env: { LOG_LEVEL: "silent" },
    });

    // Pipe local stdin → runner PTY
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      daemon.sendInput(sid, data);
    });

    // Forward terminal resize
    process.stdout.on("resize", () => {
      daemon.resizeSession(
        sid,
        process.stdout.columns || 120,
        process.stdout.rows || 40,
      );
    });

    const runner = daemon.getRunner(sid);
    if (runner?.process) {
      const exitCode = await runner.process.exited;
      cleanup();
      process.exit(exitCode);
    } else {
      console.error(
        errorWithHints("Failed to spawn Claude Code runner.", [
          "Verify `claude` is installed and on your PATH",
          "Try: tp doctor",
        ]),
      );
      cleanup();
      process.exit(1);
    }
  } catch (err) {
    console.error(
      errorWithHints(
        `Failed to start passthrough session: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ["Try: tp doctor", "Check that `claude` is installed and on your PATH"],
      ),
    );
    cleanup();
    process.exit(1);
  }
}

async function showFirstRunPairing(): Promise<void> {
  const store = new Store();
  try {
    if (store.listPairings().length > 0) return;
  } finally {
    store.close();
  }

  console.error(bold(cyan("Welcome to Teleprompter!")));
  console.error("tp wraps Claude Code for remote session control.\n");
  console.error(
    "Scan this QR code with the Teleprompter app to connect your phone:",
  );
  console.error(dim("(Web: tpmt.dev · iOS: TestFlight · Android: Internal)"));
  console.error("");

  try {
    const { pairCommand } = await import("./pair");
    await pairCommand([]);
  } catch {
    console.error(dim("\nPairing skipped. Run `tp pair` later to connect."));
  }

  console.error("");
  try {
    const { installService } = await import("../lib/service");
    await installService();
  } catch {
    console.error(
      dim("Daemon service install skipped. Run `tp daemon install` manually."),
    );
  }
  console.error("");

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(INIT_MARKER, new Date().toISOString());
  } catch {}
}
