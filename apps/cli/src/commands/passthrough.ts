/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Starts a daemon + runner in-process, spawning claude with all non-tp args.
 * This is the default mode when no subcommand is given.
 */

import { Daemon, SessionManager } from "@teleprompter/daemon";
import { setLogLevel } from "@teleprompter/protocol";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { splitArgs } from "../args";
import { bold, cyan, dim, ok } from "../lib/colors";
import { errorWithHints } from "../lib/format";
import { resolveRunnerCommand } from "../spawn";

const CONFIG_DIR = join(process.env.HOME ?? "/tmp", ".config", "teleprompter");
const INIT_MARKER = join(CONFIG_DIR, ".tp-initialized");

export async function passthroughCommand(argv: string[]): Promise<void> {
  // Check claude is available (spawnSync may not throw — check exitCode too)
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

  // First-run: show pairing QR if no pairing exists
  await showFirstRunPairing();

  const { tpArgs, claudeArgs } = splitArgs(argv);

  const sid = tpArgs.sid ?? `session-${Date.now()}`;
  const cwd = tpArgs.cwd ?? process.cwd();

  // Suppress all daemon/runner logs — PTY output owns the terminal.
  // Set env var BEFORE setLogLevel so child processes inherit it.
  process.env.LOG_LEVEL = "silent";
  setLogLevel("silent");

  // Inject self-spawn runner command
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  // Use a temporary IPC socket to avoid conflicting with background daemon
  const tmpSocket = join(
    process.env.TMPDIR ?? "/tmp",
    `tp-passthrough-${process.pid}.sock`,
  );

  const daemon = new Daemon();
  daemon.start(tmpSocket);

  // WS only needed if no background daemon is running
  // (background daemon already handles remote frontends)
  try {
    daemon.startWs(0); // auto-assign port — never conflict
  } catch {
    // WS not critical for passthrough
  }

  // Pipe PTY output to local terminal
  daemon.onRecord = (_sid, kind, payload) => {
    if (kind === "io") {
      process.stdout.write(payload);
    }
  };

  // Spawn runner with claude args and actual terminal size
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  daemon.createSession(sid, cwd, {
    claudeArgs,
    cols,
    rows,
    env: { LOG_LEVEL: "silent" },
  });

  // Pipe local stdin to runner PTY (raw mode for interactive use)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    daemon.sendInput(sid, data);
  });

  // Forward terminal resize events
  process.stdout.on("resize", () => {
    daemon.resizeSession(
      sid,
      process.stdout.columns || 120,
      process.stdout.rows || 40,
    );
  });

  function shutdown() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    daemon.stop();
    try {
      require("fs").unlinkSync(tmpSocket);
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for the runner process to exit
  const runner = daemon.getRunner(sid);
  if (runner?.process) {
    const exitCode = await runner.process.exited;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    daemon.stop();
    try {
      require("fs").unlinkSync(tmpSocket);
    } catch {}
    process.exit(exitCode);
  }
}

async function showFirstRunPairing(): Promise<void> {
  const pairingFile = join(CONFIG_DIR, "pairing.json");
  if (existsSync(pairingFile)) return;

  // First run — generate pairing and show QR
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
    // Pairing failed — continue anyway, user can run `tp pair` later
    console.error(dim("\nPairing skipped. Run `tp pair` later to connect."));
  }

  // Auto-install daemon as OS service (launchd/systemd)
  console.error("");
  try {
    const { installService } = await import("../lib/service");
    await installService();
  } catch {
    console.error(dim("Daemon service install skipped. Run `tp daemon install` manually."));
  }
  console.error("");

  // Mark as initialized
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(INIT_MARKER, new Date().toISOString());
  } catch {}
}
