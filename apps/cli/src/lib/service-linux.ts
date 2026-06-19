import { existsSync } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { resolveTpBinary } from "./paths";

export { resolveTpBinary };

const SERVICE_NAME = "teleprompter-daemon";

function getUnitDir(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/tmp", ".config"),
    "systemd",
    "user",
  );
}

function getUnitPath(): string {
  return join(getUnitDir(), `${SERVICE_NAME}.service`);
}

export function isServiceInstalled(): boolean {
  return existsSync(getUnitPath());
}

export function getServiceName(): string {
  return SERVICE_NAME;
}

export function generateUnit(tpBinary: string): string {
  return `[Unit]
Description=Teleprompter Daemon
After=network.target

[Service]
ExecStart=${tpBinary} daemon start
Restart=on-failure
RestartSec=5
Environment=HOME=${process.env.HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${process.env.HOME}/.local/bin

[Install]
WantedBy=default.target
`;
}

export async function installLinux(): Promise<void> {
  const tpBinary = resolveTpBinary();
  const unitDir = getUnitDir();
  const unitPath = getUnitPath();

  // Create systemd user directory
  await mkdir(unitDir, { recursive: true });

  // Generate and write unit file
  const unit = generateUnit(tpBinary);
  await writeFile(unitPath, unit);

  // Reload systemd and enable the service
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  const enableResult = Bun.spawnSync([
    "systemctl",
    "--user",
    "enable",
    "--now",
    SERVICE_NAME,
  ]);
  if (enableResult.exitCode !== 0) {
    console.error(
      `[Service] systemctl enable failed: ${enableResult.stderr.toString()}`,
    );
    return;
  }

  console.log(`[Service] Installed systemd user service: ${SERVICE_NAME}`);
  console.log(`[Service] Unit: ${unitPath}`);
  console.log(`[Service] Binary: ${tpBinary}`);
  console.log(`\nThe daemon will start automatically on login.`);
  console.log(`To check status: systemctl --user status ${SERVICE_NAME}`);
}

export async function uninstallLinux(): Promise<void> {
  const unitPath = getUnitPath();

  if (!existsSync(unitPath)) {
    console.log(`[Service] No systemd service found at ${unitPath}`);
    return;
  }

  // Stop and disable the service
  Bun.spawnSync(["systemctl", "--user", "disable", "--now", SERVICE_NAME]);

  // Remove unit file
  await unlink(unitPath);

  // Reload systemd
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);

  console.log(`[Service] Uninstalled systemd user service: ${SERVICE_NAME}`);
  console.log(`[Service] Removed: ${unitPath}`);
}
