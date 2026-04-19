import { getSocketPath } from "@teleprompter/protocol";
import { spawn } from "child_process";
import { existsSync, lstatSync, unlinkSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { Socket } from "net";
import { platform } from "os";
import { join } from "path";
import { dim, ok } from "./colors";
import { errorWithHints } from "./format";
import { spinner } from "./spinner";

/**
 * Platform-appropriate config directory for tp state files.
 * Windows: `%APPDATA%\teleprompter` (with `%USERPROFILE%\AppData\Roaming` fallback).
 * Unix: `$HOME/.config/teleprompter` (POSIX XDG-style).
 */
function getConfigDir(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ??
        join(
          process.env.USERPROFILE ?? "C:\\Users\\Default",
          "AppData",
          "Roaming",
        ))
      : join(process.env.HOME ?? "/tmp", ".config");
  return join(base, "teleprompter");
}

const HINT_FILE = join(getConfigDir(), ".daemon-hint-shown");

/**
 * Check whether the background daemon is running by probing its IPC socket.
 *
 * A bare socket file can linger after a crashed daemon. We attempt to connect;
 * if connect fails with ECONNREFUSED (or the file is not a socket at all), we
 * treat it as stale and remove it. Transient errors (ETIMEDOUT, EAGAIN, …) are
 * reported as "not running" without touching the file — safer under a race
 * with a daemon that's mid-startup.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const sockPath = getSocketPath();
  if (!existsSync(sockPath)) return false;

  // Windows named pipes: existence check is sufficient — the pipe disappears
  // when the daemon process exits.
  if (process.platform === "win32") return true;

  // If the path exists but is not a socket (e.g. a leftover regular file from
  // a misconfigured run), it's safe to remove.
  try {
    if (!lstatSync(sockPath).isSocket()) {
      try {
        unlinkSync(sockPath);
      } catch {
        // best effort
      }
      return false;
    }
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let settled = false;
    const timer = setTimeout(() => settle(false, null), 500);

    const settle = (alive: boolean, errCode: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      if (!alive && errCode === "ECONNREFUSED") {
        try {
          unlinkSync(sockPath);
        } catch {
          // best effort
        }
      }
      resolve(alive);
    };

    sock.once("connect", () => settle(true, null));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      settle(false, err.code ?? null);
    });
    sock.connect(sockPath);
  });
}

/**
 * Ensure daemon is running. If not, try to start it:
 * 1. If OS service is installed → kickstart it
 * 2. Otherwise → spawn in background + show install hint once
 * Returns true when the daemon IPC socket is reachable.
 */
export async function ensureDaemon(): Promise<boolean> {
  if (await isDaemonRunning()) return true;

  const stop = spinner("Starting daemon...");

  // Try kickstarting the OS service if installed
  if (await tryKickstartService()) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isDaemonRunning()) {
        stop(ok(`Daemon started via system service`));
        return true;
      }
    }
    // fall through to manual spawn
  }

  // Spawn daemon in background
  const args = ["run", "apps/cli/src/index.ts", "daemon", "start"];

  const proc = spawn("bun", args, {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, LOG_LEVEL: "error" },
  });
  proc.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning()) {
      stop(ok(`Daemon started (pid=${proc.pid})`));
      await showInstallHint();
      return true;
    }
  }

  stop();
  console.error(
    errorWithHints("Failed to start daemon.", [
      "Start manually: tp daemon start --verbose",
      "Diagnose: tp doctor",
    ]),
  );
  return false;
}

/**
 * Check if OS service is installed and try to kickstart it.
 * Returns true if kickstart was attempted.
 */
async function tryKickstartService(): Promise<boolean> {
  const os = platform();

  if (os === "darwin") {
    const { isServiceInstalled, getServiceLabel } = await import(
      "./service-darwin"
    );
    if (!isServiceInstalled()) return false;

    const uid = process.getuid?.() ?? 501;
    const label = getServiceLabel();
    Bun.spawnSync(["launchctl", "kickstart", `gui/${uid}/${label}`]);
    return true;
  }

  if (os === "linux") {
    const { isServiceInstalled, getServiceName } = await import(
      "./service-linux"
    );
    if (!isServiceInstalled()) return false;

    Bun.spawnSync(["systemctl", "--user", "start", getServiceName()]);
    return true;
  }

  if (os === "win32") {
    const { isServiceInstalled, getTaskName } = await import(
      "./service-windows"
    );
    if (!isServiceInstalled()) return false;

    Bun.spawnSync(["schtasks", "/Run", "/TN", getTaskName()]);
    return true;
  }

  return false;
}

/**
 * On the first real run, offer to install the daemon as an OS service so it
 * starts automatically on login. Non-interactive environments (CI, scripts
 * piping stdin) fall back to a one-time dim hint. Setting
 * `TP_NO_AUTO_INSTALL=1` forces the hint-only path even on a TTY.
 */
async function showInstallHint(): Promise<void> {
  const mode = decideInstallPromptMode({
    hintFileExists: existsSync(HINT_FILE),
    serviceInstalled: await isServiceInstalledAny(),
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    noAutoInstallEnv: process.env.TP_NO_AUTO_INSTALL === "1",
  });

  if (mode === "skip") return;

  if (mode === "hint") {
    console.error(
      dim("Tip: Run 'tp daemon install' to start tp automatically on login."),
    );
    await markHinted();
    return;
  }

  // Context line so a first-run user understands what the prompt is about
  // before answering.
  console.error(
    dim(
      "tp daemon is now running in the background. It can also auto-start on login.",
    ),
  );
  const accepted = await promptYesNo(
    "Install daemon as an OS service so it auto-starts on login? [Y/n] ",
  );
  await markHinted();

  if (!accepted) {
    console.error(
      dim("Skipping. Run 'tp daemon install' later to enable auto-start."),
    );
    return;
  }

  try {
    const { installService } = await import("./service");
    await installService();
  } catch (err) {
    console.error(
      dim(
        `Service install failed: ${
          err instanceof Error ? err.message : String(err)
        }. Run 'tp daemon install' manually.`,
      ),
    );
  }
}

async function isServiceInstalledAny(): Promise<boolean> {
  const os = platform();
  if (os === "darwin") {
    const { isServiceInstalled } = await import("./service-darwin");
    return isServiceInstalled();
  }
  if (os === "linux") {
    const { isServiceInstalled } = await import("./service-linux");
    return isServiceInstalled();
  }
  if (os === "win32") {
    const { isServiceInstalled } = await import("./service-windows");
    return isServiceInstalled();
  }
  return false;
}

async function markHinted(): Promise<void> {
  try {
    await mkdir(getConfigDir(), { recursive: true });
    await writeFile(HINT_FILE, new Date().toISOString());
  } catch {
    // Non-critical — just skip
  }
}

/**
 * Minimal interface covering the pieces of a Readable stream we actually
 * use. Extracted so `readYesNoLine` can be unit-tested against a
 * PassThrough stream without hitting the real `process.stdin`.
 */
export interface YesNoReadable {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  once(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Read a single y/n answer from the supplied readable stream.
 *
 * Resolves on:
 *  - the first newline → parsed via `parseYesNoAnswer` with `defaultYes=true`
 *  - `end` or `close` (stdin EOF, Ctrl+D, upstream pipe gone) → `false`,
 *    because the action installs a system service and abnormal-close
 *    should not be treated as implicit consent.
 *
 * The single `done()` closure removes all listeners and pauses the stream
 * exactly once, so the function never leaks handlers even under
 * concurrent `data`/`end` races.
 *
 * @internal Exported for unit tests; not part of the public CLI API.
 */
export async function readYesNoLine(stream: YesNoReadable): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let buf = "";
    let settled = false;

    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      stream.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      done(parseYesNoAnswer(buf.slice(0, idx), true));
    };
    const onEnd = () => done(false);

    stream.resume();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
  });
}

/** Write the prompt to stderr and read a single y/n line from stdin. */
async function promptYesNo(prompt: string): Promise<boolean> {
  process.stderr.write(prompt);
  return readYesNoLine(process.stdin);
}

/**
 * Normalize a y/n response.
 *
 * Rules, applied in order:
 *  - empty / whitespace-only → `defaultYes`
 *  - starts with ASCII `n` (e.g. `n`, `no`, `nope`, `nah`, `nil`) → `false`
 *  - starts with ASCII `y` (e.g. `y`, `yes`, `yep`, `yikes`) → `true`
 *  - anything else → `defaultYes`
 *
 * Starts-with matching favours declining over the default when the user
 * clearly typed something `n`-ish, which is the safe direction for
 * destructive-ish actions like installing a system service. Over-matching
 * on words like `nil` / `yikes` is intentional — typo-tolerance beats a
 * strict whitelist here since the prompt is English-only.
 *
 * Non-ASCII responses (e.g. `아니요`, `いいえ`, `нет`) intentionally fall
 * back to `defaultYes`; the prompt string is English-only so the locale
 * mismatch is unlikely to arise in practice.
 *
 * @internal Exported for unit tests; not part of the public CLI API.
 */
export function parseYesNoAnswer(raw: string, defaultYes: boolean): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  if (trimmed.startsWith("n")) return false;
  if (trimmed.startsWith("y")) return true;
  return defaultYes;
}

/**
 * Decide which branch `showInstallHint` should take, without any I/O.
 *
 * @internal Exported for unit tests.
 */
export type InstallPromptMode = "skip" | "hint" | "prompt";

/**
 * Inputs to the gate decision. Parameterised so tests can exercise every
 * branch without stubbing the live `process` object.
 *
 * @internal
 */
export type InstallPromptInputs = {
  hintFileExists: boolean;
  serviceInstalled: boolean;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  noAutoInstallEnv: boolean;
};

/**
 * Pure decision for the first-run install flow. Returns:
 *  - "skip" — already hinted OR already installed (no output, no prompt)
 *  - "hint" — non-interactive env; print the dim one-liner and stamp the file
 *  - "prompt" — interactive; ask the user and act on the answer
 *
 * @internal Exported for unit tests.
 */
export function decideInstallPromptMode(
  inputs: InstallPromptInputs,
): InstallPromptMode {
  if (inputs.hintFileExists) return "skip";
  if (inputs.serviceInstalled) return "skip";
  const interactive =
    inputs.stdinIsTTY && inputs.stderrIsTTY && !inputs.noAutoInstallEnv;
  return interactive ? "prompt" : "hint";
}
