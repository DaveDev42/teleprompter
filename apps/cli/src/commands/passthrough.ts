/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Starts a daemon + runner in-process, spawning claude with all non-tp args.
 * This is the default mode when no subcommand is given.
 */

import { Daemon, SessionManager } from "@teleprompter/daemon";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { splitArgs } from "../args";
import { bold, cyan } from "../lib/colors";
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

  // First-run welcome (non-blocking, shows once)
  await showWelcomeOnce();

  const { tpArgs, claudeArgs } = splitArgs(argv);

  const sid = tpArgs.sid ?? `session-${Date.now()}`;
  const cwd = tpArgs.cwd ?? process.cwd();
  const wsPort = parseInt(tpArgs.wsPort ?? "7080", 10);

  // Inject self-spawn runner command
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const daemon = new Daemon();
  const _socketPath = daemon.start();
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

async function showWelcomeOnce(): Promise<void> {
  if (existsSync(INIT_MARKER)) return;

  const hasPairing = existsSync(join(CONFIG_DIR, "pairing.json"));

  console.error(cyan("Welcome to Teleprompter!"));
  console.error("tp wraps Claude Code for remote session control.");
  if (!hasPairing) {
    console.error(`To connect your phone: ${bold("tp pair")}`);
  }
  console.error("");

  // Mark as shown
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(INIT_MARKER, new Date().toISOString());
  } catch {
    // Non-critical
  }
}
