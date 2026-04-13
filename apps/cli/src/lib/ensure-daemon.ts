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

const HINT_FILE = join(
  process.platform === "win32"
    ? (process.env.APPDATA ??
        join(
          process.env.USERPROFILE ?? "C:\\Users\\Default",
          "AppData",
          "Roaming",
        ))
    : join(process.env.HOME ?? "/tmp", ".config"),
  "teleprompter",
  ".daemon-hint-shown",
);

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
 * Show a one-time hint about installing the daemon as an OS service.
 */
async function showInstallHint(): Promise<void> {
  if (existsSync(HINT_FILE)) return;

  const os = platform();
  if (os === "darwin") {
    const { isServiceInstalled } = await import("./service-darwin");
    if (isServiceInstalled()) return;
  } else if (os === "linux") {
    const { isServiceInstalled } = await import("./service-linux");
    if (isServiceInstalled()) return;
  } else if (os === "win32") {
    const { isServiceInstalled } = await import("./service-windows");
    if (isServiceInstalled()) return;
  }

  console.error(
    dim("Tip: Run 'tp daemon install' to start tp automatically on login."),
  );

  try {
    const dir = join(
      process.platform === "win32"
        ? (process.env.APPDATA ??
            join(
              process.env.USERPROFILE ?? "C:\\Users\\Default",
              "AppData",
              "Roaming",
            ))
        : join(process.env.HOME ?? "/tmp", ".config"),
      "teleprompter",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(HINT_FILE, new Date().toISOString());
  } catch {
    // Non-critical — just skip
  }
}
