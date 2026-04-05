/**
 * Forward arguments directly to the `claude` CLI without daemon/runner.
 *
 * Used for:
 * - Claude utility subcommands (auth, mcp, install, update, agents, etc.)
 * - Explicit passthrough via `tp -- <args>`
 */

import { errorWithHints } from "../lib/format";

export async function forwardToClaudeCommand(argv: string[]): Promise<void> {
  const check = Bun.spawnSync(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.error(
      errorWithHints("Claude Code CLI not found.", [
        "Install: https://docs.anthropic.com/en/docs/claude-code",
        "Or: npm install -g @anthropic-ai/claude-code",
      ]),
    );
    process.exit(1);
  }

  const proc = Bun.spawn(["claude", ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
