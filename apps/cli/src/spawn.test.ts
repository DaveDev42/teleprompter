import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveRunnerCommand,
  resolveRunnerCommandWithOverride,
} from "./spawn";

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
    if (cliEntry === undefined) throw new Error("expected cmd[2]");
    expect(cliEntry).toContain("index.ts");
    expect(existsSync(cliEntry)).toBe(true);
    const cmd3 = cmd[3];
    if (cmd3 === undefined) throw new Error("expected cmd[3]");
    expect(cmd3).toBe("run");
  });

  test("resolved command is executable", async () => {
    const cmd = resolveRunnerCommand();
    // Verify the first element (bun or tp binary) exists
    const cmd0 = cmd[0];
    if (cmd0 === undefined) throw new Error("expected cmd[0]");
    const which = Bun.spawnSync(["which", cmd0]);
    expect(which.exitCode).toBe(0);
  });
});

describe("resolveRunnerCommandWithOverride", () => {
  test("absent TP_RUNNER_BIN is byte-identical to the Bun default", () => {
    // The opt-in is off → must deep-equal the untouched default resolution.
    expect(resolveRunnerCommandWithOverride({})).toEqual(
      resolveRunnerCommand(),
    );
  });

  test("empty TP_RUNNER_BIN falls through to the Bun default", () => {
    expect(resolveRunnerCommandWithOverride({ TP_RUNNER_BIN: "" })).toEqual(
      resolveRunnerCommand(),
    );
  });

  test("valid TP_RUNNER_BIN → single-element [path] with no 'run' shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-runner-override-"));
    const bin = join(dir, "tp-runner");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const cmd = resolveRunnerCommandWithOverride({ TP_RUNNER_BIN: bin });
    expect(cmd).toEqual([bin]);
    // The Rust binary takes --sid/--cwd/... directly — no subcommand.
    expect(cmd).not.toContain("run");
    expect(cmd).not.toContain("bun");
  });

  test("invalid TP_RUNNER_BIN throws (never silent Bun fallback)", () => {
    expect(() =>
      resolveRunnerCommandWithOverride({
        TP_RUNNER_BIN: join(tmpdir(), "nope-not-here-xyz"),
      }),
    ).toThrow(/TP_RUNNER_BIN/);
  });
});
