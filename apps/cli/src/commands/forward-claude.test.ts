import { describe, expect, test } from "bun:test";
import { CLAUDE_UTILITY_SUBCOMMANDS } from "../claude-subcommands";

describe("CLAUDE_UTILITY_SUBCOMMANDS", () => {
  test("includes all known claude utility subcommands", () => {
    const expected = [
      "auth",
      "mcp",
      "install",
      "update",
      "agents",
      "auto-mode",
      "plugin",
      "plugins",
      "setup-token",
    ];
    for (const cmd of expected) {
      expect(CLAUDE_UTILITY_SUBCOMMANDS.has(cmd)).toBe(true);
    }
  });

  test("does not include tp subcommands", () => {
    const tpSubcommands = [
      "daemon",
      "run",
      "relay",
      "pair",
      "status",
      "logs",
      "doctor",
      "upgrade",
      "completions",
      "version",
    ];
    for (const cmd of tpSubcommands) {
      expect(CLAUDE_UTILITY_SUBCOMMANDS.has(cmd)).toBe(false);
    }
  });

  test("does not include session-mode commands", () => {
    // These are meant to go through passthrough, not direct forward
    expect(CLAUDE_UTILITY_SUBCOMMANDS.has("-p")).toBe(false);
    expect(CLAUDE_UTILITY_SUBCOMMANDS.has("--model")).toBe(false);
    expect(CLAUDE_UTILITY_SUBCOMMANDS.has("--print")).toBe(false);
  });
});
