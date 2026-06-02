import { existsSync } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { resolveTpBinary } from "./paths";

export { resolveTpBinary };

const LABEL = "dev.tpmt.daemon";

export function getPlistPath(): string {
  return join(
    process.env.HOME ?? "/tmp",
    "Library",
    "LaunchAgents",
    `${LABEL}.plist`,
  );
}

export function isServiceInstalled(): boolean {
  return existsSync(getPlistPath());
}

export function getServiceLabel(): string {
  return LABEL;
}

function getLogDir(): string {
  return join(
    process.env.XDG_DATA_HOME ??
      join(process.env.HOME ?? "/tmp", ".local", "share"),
    "teleprompter",
    "logs",
  );
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

function sleepSync(ms: number): void {
  Bun.spawnSync(["sleep", (ms / 1000).toFixed(3)]);
}

/** True when launchd still knows about the service in this domain. */
function isLoaded(serviceTarget: string): boolean {
  return Bun.spawnSync(["launchctl", "print", serviceTarget]).exitCode === 0;
}

/**
 * `launchctl bootout` is asynchronous — it *starts* the teardown but returns
 * before launchd has finished unloading the job. A `bootstrap` fired into that
 * window races the incomplete teardown and launchd answers with
 * `5: Input/output error`. Wait until `print` reports the service is gone
 * (bounded), so the subsequent bootstrap lands on a clean domain.
 */
function bootoutAndWait(serviceTarget: string): void {
  // No-op (exit 3 "No such process") if it was never loaded — that's fine.
  Bun.spawnSync(["launchctl", "bootout", serviceTarget]);
  // Poll for teardown completion: up to ~3s (30 × 100ms).
  for (let i = 0; i < 30; i++) {
    if (!isLoaded(serviceTarget)) return;
    sleepSync(100);
  }
}

export async function installDarwin(): Promise<void> {
  const tpBinary = resolveTpBinary();
  const logDir = getLogDir();
  const plistPath = getPlistPath();

  // Create log directory
  await mkdir(logDir, { recursive: true });

  // Create LaunchAgents directory
  await mkdir(join(process.env.HOME ?? "/tmp", "Library", "LaunchAgents"), {
    recursive: true,
  });

  // Generate and write plist
  const plist = generatePlist(tpBinary, logDir);
  await writeFile(plistPath, plist);

  // Bootstrap the service (modern launchctl API, replaces deprecated `load`)
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${LABEL}`;

  // bootout first to avoid "already loaded" errors, then WAIT for the async
  // teardown to finish before bootstrapping (otherwise EIO / error 5).
  bootoutAndWait(serviceTarget);

  // bootstrap can still lose the teardown race on a busy launchd, returning
  // `5: Input/output error`. Retry a few times with a short settle in between.
  let result = Bun.spawnSync(["launchctl", "bootstrap", domain, plistPath]);
  for (let attempt = 1; attempt < 5 && result.exitCode !== 0; attempt++) {
    const stderr = result.stderr.toString();
    // Only retry the teardown-race error; surface anything else immediately.
    if (!/\b5: Input\/output error\b/.test(stderr)) break;
    sleepSync(300);
    bootoutAndWait(serviceTarget);
    result = Bun.spawnSync(["launchctl", "bootstrap", domain, plistPath]);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    console.error(`[Service] launchctl bootstrap failed: ${stderr}`);
    return;
  }

  // RunAtLoad usually starts it, but kickstart -k guarantees a (re)start now
  // so a freshly-installed binary is running immediately, not on next login.
  Bun.spawnSync(["launchctl", "kickstart", "-k", serviceTarget]);

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
