import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveRunnerBinOverride } from "./runner-bin";

describe("resolveRunnerBinOverride", () => {
  test("returns null when TP_RUNNER_BIN is unset", () => {
    expect(resolveRunnerBinOverride({})).toBeNull();
  });

  test("returns null when TP_RUNNER_BIN is the empty string", () => {
    expect(resolveRunnerBinOverride({ TP_RUNNER_BIN: "" })).toBeNull();
  });

  test("returns the path for a real executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-runner-bin-"));
    const bin = join(dir, "tp-runner");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(resolveRunnerBinOverride({ TP_RUNNER_BIN: bin })).toBe(bin);
  });

  test("throws (naming the path + build hint) when the path does not exist", () => {
    const missing = join(tmpdir(), "tp-runner-does-not-exist-xyz");
    expect(() => resolveRunnerBinOverride({ TP_RUNNER_BIN: missing })).toThrow(
      /TP_RUNNER_BIN/,
    );
    // Includes the cargo build hint so the operator knows how to recover.
    try {
      resolveRunnerBinOverride({ TP_RUNNER_BIN: missing });
    } catch (e) {
      expect(e instanceof Error && e.message).toContain("cargo build");
      expect(e instanceof Error && e.message).toContain(missing);
    }
  });

  test("throws when the path exists but is not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-runner-bin-"));
    const notExec = join(dir, "not-exec");
    writeFileSync(notExec, "data");
    chmodSync(notExec, 0o644);
    expect(() => resolveRunnerBinOverride({ TP_RUNNER_BIN: notExec })).toThrow(
      /not an executable file/,
    );
  });
});
