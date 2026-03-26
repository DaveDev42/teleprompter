import { join } from "path";
import { mkdir, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";

const LABEL = "dev.tpmt.daemon";

function getPlistPath(): string {
  return join(process.env.HOME ?? "/tmp", "Library", "LaunchAgents", `${LABEL}.plist`);
}

function getLogDir(): string {
  return join(
    process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
    "teleprompter",
    "logs",
  );
}

export function resolveTpBinary(): string {
  // Prefer the compiled binary
  const candidates = [
    join(process.env.HOME ?? "", ".local", "bin", "tp"),
    "/usr/local/bin/tp",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: use process.argv path (running from bun)
  return process.argv[0];
}

export function generatePlist(tpBinary: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${tpBinary}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logDir, "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, "daemon.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${process.env.HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${process.env.HOME}/.local/bin</string>
  </dict>
</dict>
</plist>`;
}

export async function installDarwin(): Promise<void> {
  const tpBinary = resolveTpBinary();
  const logDir = getLogDir();
  const plistPath = getPlistPath();

  // Create log directory
  await mkdir(logDir, { recursive: true });

  // Create LaunchAgents directory
  await mkdir(join(process.env.HOME ?? "/tmp", "Library", "LaunchAgents"), { recursive: true });

  // Generate and write plist
  const plist = generatePlist(tpBinary, logDir);
  await writeFile(plistPath, plist);

  // Bootstrap the service (modern launchctl API, replaces deprecated `load`)
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  // bootout first to avoid "already loaded" errors
  Bun.spawnSync(["launchctl", "bootout", `${domain}/${LABEL}`]);
  const result = Bun.spawnSync(["launchctl", "bootstrap", domain, plistPath]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    console.error(`[Service] launchctl bootstrap failed: ${stderr}`);
    return;
  }

  console.log(`[Service] Installed launchd service: ${LABEL}`);
  console.log(`[Service] Plist: ${plistPath}`);
  console.log(`[Service] Logs: ${join(logDir, "daemon.log")}`);
  console.log(`[Service] Binary: ${tpBinary}`);
  console.log(`\nThe daemon will start automatically on login.`);
  console.log(`To check status: launchctl list ${LABEL}`);
}

export async function uninstallDarwin(): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    console.log(`[Service] No launchd service found at ${plistPath}`);
    return;
  }

  // Bootout the service (modern launchctl API, replaces deprecated `unload`)
  const uid = process.getuid?.() ?? 501;
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${LABEL}`]);

  // Remove plist file
  await unlink(plistPath);

  console.log(`[Service] Uninstalled launchd service: ${LABEL}`);
  console.log(`[Service] Removed: ${plistPath}`);
}
