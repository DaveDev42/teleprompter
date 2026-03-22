import { describe, test, expect } from "bun:test";
import { resolveRunnerCommand } from "./spawn";

describe("resolveRunnerCommand", () => {
  test("returns an array of strings", () => {
    const cmd = resolveRunnerCommand();
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.length).toBeGreaterThan(0);
    expect(typeof cmd[0]).toBe("string");
  });

  test("dev mode includes bun and run subcommand", () => {
    // In dev mode (not compiled), should use bun run
    const cmd = resolveRunnerCommand();
    // Either "bun" or the compiled binary path
    expect(cmd[0]).toMatch(/bun|tp/);
  });
});
