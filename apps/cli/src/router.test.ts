import { describe, expect, test } from "bun:test";
import { decideRoute, shouldCheckForUpdates } from "./router";

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
    // first arg — must route to passthrough so claude sees them unchanged.
    expect(decideRoute("-p")).toEqual({ kind: "passthrough" });
    expect(decideRoute("--model")).toEqual({ kind: "passthrough" });
    expect(decideRoute("--print")).toEqual({ kind: "passthrough" });
    expect(decideRoute("hello")).toEqual({ kind: "passthrough" });
  });
});

describe("shouldCheckForUpdates", () => {
  test("passthrough triggers update check", () => {
    expect(shouldCheckForUpdates({ kind: "passthrough" })).toBe(true);
  });

  test("upgrade/doctor/pair subcommands trigger update check", () => {
    expect(
      shouldCheckForUpdates({ kind: "subcommand", name: "upgrade" }),
    ).toBe(true);
    expect(
      shouldCheckForUpdates({ kind: "subcommand", name: "doctor" }),
    ).toBe(true);
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
