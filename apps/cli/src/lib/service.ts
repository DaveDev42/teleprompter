import { platform } from "os";

export { resolveTpBinary } from "./paths";

export async function installService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    const { installDarwin } = await import("./service-darwin");
    return installDarwin();
  }
  if (os === "linux") {
    const { installLinux } = await import("./service-linux");
    return installLinux();
  }
  if (os === "win32") {
    const { installWindows } = await import("./service-windows");
    return installWindows();
  }
  console.error(`[Service] Unsupported platform: ${os}`);
  console.error(
    `[Service] Supported: macOS (launchd), Linux (systemd), Windows (Task Scheduler)`,
  );
  process.exit(1);
}

export async function uninstallService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    const { uninstallDarwin } = await import("./service-darwin");
    return uninstallDarwin();
  }
  if (os === "linux") {
    const { uninstallLinux } = await import("./service-linux");
    return uninstallLinux();
  }
  if (os === "win32") {
    const { uninstallWindows } = await import("./service-windows");
    return uninstallWindows();
  }
  console.error(`[Service] Unsupported platform: ${os}`);
  process.exit(1);
}

/** Whether an OS service for the daemon is registered on the current platform. */
export async function isServiceInstalled(): Promise<boolean> {
  const os = platform();
  if (os === "darwin") {
    const { isServiceInstalled: check } = await import("./service-darwin");
    return check();
  }
  if (os === "linux") {
    const { isServiceInstalled: check } = await import("./service-linux");
    return check();
  }
  if (os === "win32") {
    const { isServiceInstalled: check } = await import("./service-windows");
    return check();
  }
  return false;
}

/**
 * Ask the OS service manager to start the daemon. No-op (returns `false`)
 * on platforms where the service isn't installed.
 */
export async function startService(): Promise<boolean> {
  const os = platform();
  if (os === "darwin") {
    const { isServiceInstalled: check, getServiceLabel } = await import(
      "./service-darwin"
    );
    if (!check()) return false;
    const uid = process.getuid?.() ?? 501;
    Bun.spawnSync([
      "launchctl",
      "kickstart",
      `gui/${uid}/${getServiceLabel()}`,
    ]);
    return true;
  }
  if (os === "linux") {
    const { isServiceInstalled: check, getServiceName } = await import(
      "./service-linux"
    );
    if (!check()) return false;
    Bun.spawnSync(["systemctl", "--user", "start", getServiceName()]);
    return true;
  }
  if (os === "win32") {
    const { isServiceInstalled: check, getTaskName } = await import(
      "./service-windows"
    );
    if (!check()) return false;
    Bun.spawnSync(["schtasks", "/Run", "/TN", getTaskName()]);
    return true;
  }
  return false;
}

/**
 * Ask the OS service manager to restart the daemon. Uses `kickstart -k` on
 * macOS, `systemctl restart` on Linux, and `schtasks /End` + `/Run` on
 * Windows. Returns `false` when the service isn't installed.
 */
export async function restartService(): Promise<boolean> {
  const os = platform();
  if (os === "darwin") {
    const { isServiceInstalled: check, getServiceLabel } = await import(
      "./service-darwin"
    );
    if (!check()) return false;
    const uid = process.getuid?.() ?? 501;
    Bun.spawnSync([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${uid}/${getServiceLabel()}`,
    ]);
    return true;
  }
  if (os === "linux") {
    const { isServiceInstalled: check, getServiceName } = await import(
      "./service-linux"
    );
    if (!check()) return false;
    Bun.spawnSync(["systemctl", "--user", "restart", getServiceName()]);
    return true;
  }
  if (os === "win32") {
    const { isServiceInstalled: check, getTaskName } = await import(
      "./service-windows"
    );
    if (!check()) return false;
    const task = getTaskName();
    // Best-effort end; ignore failure when task isn't running.
    Bun.spawnSync(["schtasks", "/End", "/TN", task]);
    Bun.spawnSync(["schtasks", "/Run", "/TN", task]);
    return true;
  }
  return false;
}
