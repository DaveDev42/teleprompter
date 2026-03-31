import { existsSync } from "fs";
import { join } from "path";

/**
 * tp init — quick project setup.
 * Checks the environment, generates pairing if needed, and prints
 * the recommended daemon start command.
 */
export async function initCommand(): Promise<void> {
  console.log("Teleprompter Setup\n");

  const cwd = process.cwd();

  // Check if we're in a git repo
  const isGitRepo = existsSync(join(cwd, ".git"));
  if (!isGitRepo) {
    console.log("Warning: not in a git repository.");
    console.log("Worktree management will not be available.\n");
  }

  // Check for existing pairing
  const pairingPath = join(
    process.env.HOME ?? "/tmp",
    ".config",
    "teleprompter",
    "pairing.json",
  );
  const hasPairing = existsSync(pairingPath);

  // Check for Claude CLI
  let hasClaude = false;
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    hasClaude = proc.exitCode === 0;
  } catch {}

  console.log("Environment:");
  console.log(`  Git repo:     ${isGitRepo ? "yes" : "no"}`);
  console.log(`  Claude CLI:   ${hasClaude ? "yes" : "not found"}`);
  console.log(
    `  Pairing:      ${hasPairing ? "configured" : "not configured"}`,
  );
  console.log("");

  if (!hasClaude) {
    console.log("Install Claude CLI first:");
    console.log("  https://docs.anthropic.com/en/docs/claude-code\n");
    return;
  }

  // Print recommended commands
  console.log("Quick start:\n");

  console.log("  1. Start the daemon:");
  const args = ["tp daemon start"];
  if (isGitRepo) args.push(`--repo-root ${cwd}`);
  console.log(`     ${args.join(" ")}\n`);

  if (!hasPairing) {
    console.log("  2. (Optional) Set up remote access:");
    console.log("     tp relay start --port 7090");
    console.log("     tp pair --relay ws://your-server:7090\n");
  }

  console.log(`  ${hasPairing ? "2" : "3"}. Run Claude through tp:`);
  console.log("     tp -p 'explain this code'\n");

  console.log("  Or open the web UI:");
  console.log("     http://localhost:7080\n");

  console.log("For more: tp --help");
}
