/**
 * Forward arguments directly to the `claude` CLI without daemon/runner.
 *
 * Used for:
 * - Claude utility subcommands (auth, mcp, install, update, agents, etc.)
 * - Explicit passthrough via `tp -- <args>`
 */

import { errorWithHints } from "../lib/format";

export async function forwardToClaudeCommand(
  argv: string[],
  env?: Record<string, string>,
): Promise<number> {
  const spawnEnv = env ?? (process.env as Record<string, string>);
  let check: ReturnType<typeof Bun.spawnSync>;
  try {
    check = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv,
    });
  } catch {
    // Bun throws ENOENT when the binary is not found on PATH
    check = { exitCode: 1 } as ReturnType<typeof Bun.spawnSync>;
  }
  if (check.exitCode !== 0) {
    console.error(
      errorWithHints("Claude Code CLI not found.", [
        "Install: https://docs.anthropic.com/en/docs/claude-code",
        "Or: npm install -g @anthropic-ai/claude-code",
      ]),
    );
    return 1;
  }

  const proc = Bun.spawn(["claude", ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: spawnEnv,
  });

  return proc.exited;
}
