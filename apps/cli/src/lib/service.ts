import { platform } from "os";

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
