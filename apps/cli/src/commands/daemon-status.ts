import { getSocketPath } from "@teleprompter/protocol";
import { statSync } from "fs";
import { join } from "path";
import { dim, fail, green, warn } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { formatAge } from "../lib/format";

/**
 * tp daemon status — inspect the daemon service and its running state.
 *
 * Reports:
 *   - OS service registration (launchd / systemd / Task Scheduler)
 *   - Background process liveness (via IPC socket presence)
 *   - Log file location and last-modified time
 *   - Binary path the service would launch
 *
 * This is distinct from `tp status`, which focuses on sessions (the Store)
 * and only peeks at daemon liveness.
 */
export async function daemonStatusCommand(_argv: string[]): Promise<void> {
  const platform = process.platform;
  const socketPath = getSocketPath();
  const backgroundRunning = await isDaemonRunning();

  let installed = false;
  let managerHint = "";
  let binaryPath = "";
  let configPath = "";
  let logPath = "";

  if (platform === "darwin") {
    const svc = await import("../lib/service-darwin");
    installed = svc.isServiceInstalled();
    managerHint = `launchd (${svc.getServiceLabel()})`;
    binaryPath = svc.resolveTpBinary();
    configPath = svc.getPlistPath();
    logPath = join(
      process.env.XDG_DATA_HOME ??
        join(process.env.HOME ?? "/tmp", ".local", "share"),
      "teleprompter",
      "logs",
      "daemon.log",
    );
  } else if (platform === "linux") {
    const svc = await import("../lib/service-linux");
    installed = svc.isServiceInstalled();
    managerHint = `systemd --user (${svc.getServiceName()})`;
    binaryPath = svc.resolveTpBinary();
    configPath = join(
      process.env.XDG_CONFIG_HOME ??
        join(process.env.HOME ?? "/tmp", ".config"),
      "systemd",
      "user",
      `${svc.getServiceName()}.service`,
    );
    logPath = "journalctl --user -u " + svc.getServiceName();
  } else if (platform === "win32") {
    const svc = await import("../lib/service-windows");
    installed = svc.isServiceInstalled();
    managerHint = `Task Scheduler (${svc.getTaskName()})`;
    binaryPath = svc.resolveTpBinary();
    configPath = `schtasks /Query /TN "${svc.getTaskName()}"`;
    logPath = join(svc.getLogDir(), "daemon.log");
  } else {
    managerHint = `unsupported platform (${platform})`;
  }

  render({
    installed,
    backgroundRunning,
    managerHint,
    binaryPath,
    configPath,
    logPath,
    socketPath,
  });
}

type RenderOpts = {
  installed: boolean;
  backgroundRunning: boolean;
  managerHint: string;
  binaryPath: string;
  configPath: string;
  logPath: string;
  socketPath: string;
};

function render(o: RenderOpts): void {
  console.log("");
  console.log("Daemon Service");
  console.log("──────────────");
  console.log(
    `Service:    ${
      o.installed ? green("installed") : dim("not installed")
    }  (${o.managerHint})`,
  );
  console.log(
    `Process:    ${
      o.backgroundRunning ? green("running") : dim("not running")
    }`,
  );
  console.log(`Socket:     ${o.socketPath}`);
  console.log(`Binary:     ${o.binaryPath || dim("(not resolved)")}`);
  console.log(`Config:     ${o.configPath}`);
  console.log(`Logs:       ${formatLogPath(o.logPath)}`);
  console.log("");

  if (!o.installed) {
    console.log(
      `${warn("Service is not registered.")} The daemon will not start automatically on login.`,
    );
    console.log(`Register with: tp daemon install`);
    return;
  }

  if (!o.backgroundRunning) {
    console.log(
      fail("Service is installed but the daemon process is not running."),
    );
    console.log(`Start manually: tp daemon start`);
    console.log(`Or reinstall:   tp daemon uninstall && tp daemon install`);
  }
}

/**
 * Annotate the log path with its last-modified timestamp when it's a real
 * file on disk. Linux hands us a `journalctl` command instead of a path —
 * leave that alone.
 */
function formatLogPath(logPath: string): string {
  if (!logPath || logPath.startsWith("journalctl")) return logPath;
  try {
    const st = statSync(logPath);
    const age = formatAge(Date.now() - st.mtimeMs);
    return `${logPath} ${dim(`(updated ${age})`)}`;
  } catch {
    return `${logPath} ${dim("(not created yet)")}`;
  }
}
