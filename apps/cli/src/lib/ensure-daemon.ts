import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
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
 * Ensure daemon is running. If not, try to start it:
 * 1. If OS service is installed → kickstart it
 * 2. Otherwise → spawn in background + show install hint once
 * Returns when the daemon WS is reachable.
 */
export async function ensureDaemon(port = 7080): Promise<boolean> {
  // Already running — fast path
  if (await isDaemonRunning(port)) return true;

  const stop = spinner("Starting daemon...");

  // Try kickstarting the OS service if installed
  if (await tryKickstartService()) {
    // Wait for service to come up
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isDaemonRunning(port)) {
        stop(ok(`Daemon started via system service (port ${port})`));
        return true;
      }
    }
    // Service failed to start — fall through to manual spawn
  }

  // Spawn daemon in background
  const args = [
    "run",
    "apps/cli/src/index.ts",
    "daemon",
    "start",
    "--ws-port",
    String(port),
  ];

  const proc = spawn("bun", args, {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, LOG_LEVEL: "error" },
  });
  proc.unref();

  // Wait for daemon to become reachable
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning(port)) {
      stop(ok(`Daemon started (pid=${proc.pid}, port=${port})`));
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

async function isDaemonRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 1500);

    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
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
    // No -k flag: plain kickstart is a no-op if already running,
    // avoiding accidental kill of an active daemon during slow startup.
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

  // Check if already installed as service
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

  // Mark hint as shown
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
