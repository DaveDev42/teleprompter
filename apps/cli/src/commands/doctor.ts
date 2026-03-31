import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";

/**
 * tp doctor — diagnose the environment.
 * Checks for required tools, permissions, and configuration.
 */
export async function doctorCommand(): Promise<void> {
  console.log("Teleprompter Doctor\n");

  let issues = 0;

  // Bun version
  const bunVersion = Bun.version;
  check("Bun", bunVersion, true);

  // Node version
  try {
    const nodeVersion = (await $`node --version`.text()).trim();
    check("Node.js", nodeVersion, true);
  } catch {
    check("Node.js", "not found", false);
    issues++;
  }

  // pnpm
  try {
    const pnpmVersion = (await $`pnpm --version`.text()).trim();
    check("pnpm", pnpmVersion, true);
  } catch {
    check("pnpm", "not found", false);
    issues++;
  }

  // Claude CLI
  try {
    const claudeVersion = (await $`claude --version`.text()).trim();
    check("Claude CLI", claudeVersion, true);
  } catch {
    check("Claude CLI", "not found (passthrough mode won't work)", false);
    issues++;
  }

  // Git
  try {
    const gitVersion = (await $`git --version`.text()).trim();
    check("Git", gitVersion.replace("git version ", ""), true);
  } catch {
    check("Git", "not found", false);
    issues++;
  }

  // Daemon socket
  const socketPath = join(
    process.env.XDG_RUNTIME_DIR ?? `/tmp/teleprompter-${process.getuid?.()}`,
    "daemon.sock",
  );
  if (existsSync(socketPath)) {
    check("Daemon socket", socketPath, true);
  } else {
    check("Daemon socket", "not running", false);
  }

  // Pairing data
  const pairingPath = join(
    process.env.HOME ?? "/tmp",
    ".config",
    "teleprompter",
    "pairing.json",
  );
  if (existsSync(pairingPath)) {
    check("Pairing data", pairingPath, true);
  } else {
    check("Pairing data", "not configured (run tp pair)", false);
  }

  // Vault directory
  const storeDir = join(
    process.env.XDG_DATA_HOME ??
      join(process.env.HOME ?? "/tmp", ".local", "share"),
    "teleprompter",
    "vault",
  );
  if (existsSync(storeDir)) {
    check("Vault", storeDir, true);
  } else {
    check("Vault", "not created yet (starts on first daemon run)", false);
  }

  console.log("");
  if (issues === 0) {
    console.log("All checks passed!");
  } else {
    console.log(`${issues} issue(s) found.`);
  }
}

function check(name: string, value: string, ok: boolean): void {
  const icon = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[33m!\x1b[0m";
  console.log(`  ${icon} ${name}: ${value}`);
}
