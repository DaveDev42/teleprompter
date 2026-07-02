import { describe, expect, test } from "bun:test";
import { decideRoute, shouldCheckForUpdates, TP_SUBCOMMANDS } from "./router";

describe("decideRoute", () => {
  test("bare `tp` (no args) routes to passthrough", () => {
    expect(decideRoute(undefined)).toEqual({ kind: "passthrough" });
  });

  test("known tp subcommands route to subcommand", () => {
    for (const name of [
      "daemon",
      "run",
      "relay",
      "pair",
      "session",
      "status",
      "logs",
      "doctor",
      "upgrade",
      "completions",
      "version",
    ] as const) {
      expect(decideRoute(name)).toEqual({ kind: "subcommand", name });
    }
  });

  test("claude utility forwards (auth/mcp/install/...) route to claude-utility", () => {
    for (const name of [
      "auth",
      "mcp",
      "install",
      "update",
      "agents",
      "auto-mode",
      "plugin",
      "plugins",
      "setup-token",
    ]) {
      expect(decideRoute(name)).toEqual({ kind: "claude-utility" });
    }
  });

  test("`--` routes to forward-double-dash", () => {
    expect(decideRoute("--")).toEqual({ kind: "forward-double-dash" });
  });

  test("--help / -h route to help (combined tp + claude --help)", () => {
    expect(decideRoute("--help")).toEqual({ kind: "help" });
    expect(decideRoute("-h")).toEqual({ kind: "help" });
  });

  test("--version / -v route to version (combined tp + claude --version)", () => {
    expect(decideRoute("--version")).toEqual({ kind: "version" });
    expect(decideRoute("-v")).toEqual({ kind: "version" });
  });

  test("unknown args fall through to passthrough", () => {
    // Claude flags like `-p`, `--model`, etc. — and any other unrecognized
    // first arg that isn't a near-miss of a known name — must route to
    // passthrough so claude sees them unchanged.
    expect(decideRoute("-p")).toEqual({ kind: "passthrough" });
    expect(decideRoute("--model")).toEqual({ kind: "passthrough" });
    expect(decideRoute("--print")).toEqual({ kind: "passthrough" });
    expect(decideRoute("hello")).toEqual({ kind: "passthrough" });
  });

  test("flags are never typo-checked even if close to a known name", () => {
    // A `-`-prefixed token always belongs to claude, regardless of edit
    // distance to a tp subcommand name.
    expect(decideRoute("-pair")).toEqual({ kind: "passthrough" });
    expect(decideRoute("--sesion")).toEqual({ kind: "passthrough" });
  });

  test("short barewords are never typo-checked (avoids false positives)", () => {
    // Words shorter than the min-length guard sit within edit-distance 2 of
    // several unrelated known names purely by being short ("up" vs "run",
    // "ls" vs "logs") — they must still pass through untouched.
    expect(decideRoute("up")).toEqual({ kind: "passthrough" });
    expect(decideRoute("ls")).toEqual({ kind: "passthrough" });
    expect(decideRoute("log")).toEqual({ kind: "passthrough" });
  });

  test("bareword close to a known tp subcommand routes to maybe-typo", () => {
    expect(decideRoute("sesion")).toEqual({
      kind: "maybe-typo",
      name: "sesion",
      suggestion: "session",
    });
    expect(decideRoute("dameon")).toEqual({
      kind: "maybe-typo",
      name: "dameon",
      suggestion: "daemon",
    });
    expect(decideRoute("dcotor")).toEqual({
      kind: "maybe-typo",
      name: "dcotor",
      suggestion: "doctor",
    });
    expect(decideRoute("uprade")).toEqual({
      kind: "maybe-typo",
      name: "uprade",
      suggestion: "upgrade",
    });
  });

  test("bareword close to a claude utility subcommand routes to maybe-typo", () => {
    expect(decideRoute("isntall")).toEqual({
      kind: "maybe-typo",
      name: "isntall",
      suggestion: "install",
    });
  });

  test("a random english word (legitimate passthrough prompt) stays passthrough", () => {
    // These must never be misdiagnosed as typos of a tp subcommand — they
    // are exactly the "prompt handed to claude" use case the heuristic must
    // not break.
    for (const word of [
      "hello",
      "world",
      "explain",
      "summarize",
      "review",
      "commit",
      "test",
      "write",
    ]) {
      expect(decideRoute(word)).toEqual({ kind: "passthrough" });
    }
  });
});

describe("dispatchSubcommand exhaustiveness (idx 19)", () => {
  // Verifies that every entry in TP_SUBCOMMANDS has a corresponding case in
  // dispatchSubcommand (in index.ts). The static analysis (never-typed default)
  // catches this at compile time; this test documents the list so regressions
  // in the constant are visible in test output without needing a TS build.
  test("every TP_SUBCOMMAND is reachable in index.ts switch", async () => {
    const src = await Bun.file(
      new URL("./index.ts", import.meta.url).pathname,
    ).text();
    for (const name of TP_SUBCOMMANDS) {
      expect(src).toContain(`case "${name}"`);
    }
    // Exhaustiveness default must be present to catch future additions.
    expect(src).toMatch(/const _exhaustive: never = name;/);
  });
});

describe("shouldCheckForUpdates", () => {
  test("passthrough triggers update check", () => {
    expect(shouldCheckForUpdates({ kind: "passthrough" })).toBe(true);
  });

  test("upgrade/doctor/pair subcommands trigger update check", () => {
    expect(shouldCheckForUpdates({ kind: "subcommand", name: "upgrade" })).toBe(
      true,
    );
    expect(shouldCheckForUpdates({ kind: "subcommand", name: "doctor" })).toBe(
      true,
    );
    expect(shouldCheckForUpdates({ kind: "subcommand", name: "pair" })).toBe(
      true,
    );
  });

  test("status/logs/daemon/run/relay/version do not trigger update check", () => {
    for (const name of [
      "status",
      "logs",
      "daemon",
      "run",
      "relay",
      "version",
      "session",
      "completions",
    ] as const) {
      expect(shouldCheckForUpdates({ kind: "subcommand", name })).toBe(false);
    }
  });

  test("help/version/claude-utility/forward-double-dash do not trigger update check", () => {
    expect(shouldCheckForUpdates({ kind: "help" })).toBe(false);
    expect(shouldCheckForUpdates({ kind: "version" })).toBe(false);
    expect(shouldCheckForUpdates({ kind: "claude-utility" })).toBe(false);
    expect(shouldCheckForUpdates({ kind: "forward-double-dash" })).toBe(false);
  });
});
