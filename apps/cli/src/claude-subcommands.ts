/**
 * Claude-only utility subcommands that should NOT enter passthrough mode.
 * These are forwarded directly as `claude <subcmd> [args]` without daemon/runner.
 */
export const CLAUDE_UTILITY_SUBCOMMANDS = new Set([
  "auth",
  "mcp",
  "install",
  "update",
  "agents",
  "auto-mode",
  "plugin",
  "plugins",
  "setup-token",
]);
