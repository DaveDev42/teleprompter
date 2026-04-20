/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Runs claude via an in-process Daemon + Runner. PTY output pipes to
 * the local terminal; stdin pipes to the runner. Background daemon (if
 * installed as a service) is not affected — passthrough uses a temp IPC
 * socket to avoid collision.
 *
 * On first run, shows a pairing QR and auto-installs the daemon service.
 */

import { Daemon, SessionManager, Store } from "@teleprompter/daemon";
import { setLogLevel } from "@teleprompter/protocol";
import { unlinkSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { splitArgs } from "../args";
import { bold, cyan, dim } from "../lib/colors";
import { errorWithHints } from "../lib/format";
import { resolveRunnerCommand } from "../spawn";

const CONFIG_DIR = join(process.env.HOME ?? "/tmp", ".config", "teleprompter");
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

  // Temp IPC socket to avoid colliding with a background daemon service.
  const tmpSocket = join(
    process.env.TMPDIR ?? "/tmp",
    `tp-passthrough-${process.pid}.sock`,
  );

  const daemon = new Daemon();
  daemon.start(tmpSocket);

  // Pipe runner PTY io records → local stdout
  daemon.onRecord = (_sid, kind, payload) => {
    if (kind === "io") process.stdout.write(payload);
  };

  const cleanup = () => {
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
