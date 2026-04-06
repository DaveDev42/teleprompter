import { execSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PtyHostInstaller");

export function getPtyHostDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
    return join(localAppData, "teleprompter", "pty-host");
  }
  const dataDir =
    process.env.XDG_DATA_HOME ??
    join(process.env.HOME ?? "/tmp", ".local", "share");
  return join(dataDir, "teleprompter", "pty-host");
}

export function needsInstall(dir: string, currentVersion: string): boolean {
  if (!existsSync(dir)) return true;
  const versionFile = join(dir, ".version");
  if (!existsSync(versionFile)) return true;
  const installed = readFileSync(versionFile, "utf-8").trim();
  return installed !== currentVersion;
}

export function writeHostFiles(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });

  const pkg = {
    name: "teleprompter-pty-host",
    private: true,
    dependencies: {
      "@aspect-build/node-pty": "*",
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, ".version"), version);
}

export function getHostScriptPath(): string {
  return join(__dirname, "pty-windows-host.cjs");
}

export function ensurePtyHost(currentVersion: string): string {
  const dir = getPtyHostDir();

  if (!needsInstall(dir, currentVersion)) {
    log.info("pty-host up to date");
    return dir;
  }

  log.info("installing pty-host dependencies...");

  writeHostFiles(dir, currentVersion);

  const srcScript = getHostScriptPath();
  const destScript = join(dir, "pty-windows-host.cjs");
  if (existsSync(srcScript)) {
    copyFileSync(srcScript, destScript);
  }

  try {
    execSync("npm install --production", {
      cwd: dir,
      stdio: "pipe",
      timeout: 60_000,
    });
    log.info("pty-host installed successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`pty-host install failed: ${msg}`);
    throw new Error(
      `Failed to install PTY host dependencies. ` +
        `Ensure Node.js is installed and in PATH. ` +
        `Run 'tp doctor' for diagnostics.`,
    );
  }

  return dir;
}
