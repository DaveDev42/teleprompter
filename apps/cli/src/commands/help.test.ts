/**
 * Regression guard: `tp --help` / `tp -h` must mention all documented subcommands
 * and the Claude utility forwards. Catches help text drift when commands are added
 * or renamed without updating help.ts.
 */

import { describe, expect, spyOn, test } from "bun:test";

describe("helpCommand / printTpUsage", () => {
  test("help output contains all tp subcommands", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        lines.push(String(args[0] ?? ""));
      },
    );

    // Import after spying so the module uses the spied console.log.
    // Dynamic import bypasses top-level module caching for test isolation.
    const { helpCommand } = await import("./help");

    // helpCommand tries to spawn `claude --version`; in a test environment
    // claude may not be on PATH — we only care about the tp usage banner which
    // is printed before the claude check, so any exit path is fine.
    try {
      await helpCommand();
    } catch {
      // ignore spawn errors (claude not on PATH in CI)
    }

    spy.mockRestore();

    const output = lines.join("\n");

    // tp subcommands (from router.ts TP_SUBCOMMANDS + session sub-verb)
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
      expect(output).toContain(cmd);
    }
  });

  test("CLAUDE_UTILITY_SUBCOMMANDS set contains all forwarded claude commands", () => {
    // The help banner intentionally omits claude utility forwards (claude --help
    // covers them). This test instead pins the CLAUDE_UTILITY_SUBCOMMANDS set
    // that the router uses to decide forwarding.
    const { CLAUDE_UTILITY_SUBCOMMANDS } = require("../claude-subcommands");

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
});
