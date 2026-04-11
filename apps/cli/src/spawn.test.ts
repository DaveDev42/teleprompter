import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { resolveRunnerCommand } from "./spawn";

describe("resolveRunnerCommand", () => {
  test("returns array with 'run' subcommand", () => {
    const cmd = resolveRunnerCommand();
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.length).toBeGreaterThan(0);
    // Must contain "run" subcommand for the runner
    expect(cmd).toContain("run");
  });

  test("dev mode resolves to bun + real file path", () => {
    // In dev mode (bun test), should resolve to bun + index.ts
    const cmd = resolveRunnerCommand();
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toBe("run");
    // The CLI entry file must actually exist on disk
    const cliEntry = cmd[2];
    expect(cliEntry).toContain("index.ts");
    expect(existsSync(cliEntry)).toBe(true);
    expect(cmd[3]).toBe("run");
  });

  test("resolved command is executable", async () => {
    const cmd = resolveRunnerCommand();
    // Verify the first element (bun or tp binary) exists
    const which = Bun.spawnSync(["which", cmd[0]]);
    expect(which.exitCode).toBe(0);
  });
});
