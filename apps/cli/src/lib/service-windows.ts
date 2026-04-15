import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";

const TASK_NAME = "TeleprompterDaemon";

export function getLogDir(): string {
  const localAppData =
    process.env.LOCALAPPDATA ??
    join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return join(localAppData, "teleprompter", "logs");
}

export function resolveTpBinary(): string {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "teleprompter", "tp.exe"),
    join(process.env.USERPROFILE ?? "", ".local", "bin", "tp.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return process.argv[0];
}

export function isServiceInstalled(): boolean {
  const result = Bun.spawnSync(["schtasks", "/Query", "/TN", TASK_NAME]);
  return result.exitCode === 0;
}

export function getTaskName(): string {
  return TASK_NAME;
}

export function generateSchtasksArgs(
  tpBinary: string,
  logDir: string,
): string[] {
  const logFile = join(logDir, "daemon.log");
  // Wrap in cmd.exe because schtasks /TR does not support shell redirection natively
  const tr = `cmd.exe /C ""${tpBinary}" daemon start > "${logFile}" 2>&1"`;

  return [
    "/Create",
    "/TN",
    TASK_NAME,
    "/TR",
    tr,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
  ];
}

export async function installWindows(): Promise<void> {
  const tpBinary = resolveTpBinary();
  const logDir = getLogDir();

  await mkdir(logDir, { recursive: true });

  const args = generateSchtasksArgs(tpBinary, logDir);
  const result = Bun.spawnSync(["schtasks", ...args]);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    console.error(`[Service] schtasks create failed: ${stderr}`);
    return;
  }

  console.log(`[Service] Installed Task Scheduler task: ${TASK_NAME}`);
  console.log(`[Service] Binary: ${tpBinary}`);
  console.log(`[Service] Logs: ${join(logDir, "daemon.log")}`);
  console.log(`\nThe daemon will start automatically on login.`);
  console.log(`To check status: schtasks /Query /TN ${TASK_NAME}`);
}

export async function uninstallWindows(): Promise<void> {
  if (!isServiceInstalled()) {
    console.log(`[Service] No scheduled task found: ${TASK_NAME}`);
    return;
  }

  const result = Bun.spawnSync(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"]);

  if (result.exitCode !== 0) {
    console.error(
      `[Service] schtasks delete failed: ${result.stderr.toString()}`,
    );
    return;
  }

  console.log(`[Service] Uninstalled scheduled task: ${TASK_NAME}`);
}
