import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveDaemonBinOverride } from "./daemon-bin";

describe("resolveDaemonBinOverride", () => {
  test("returns null when TP_DAEMON_BIN is unset", () => {
    expect(resolveDaemonBinOverride({})).toBeNull();
  });

  test("returns null when TP_DAEMON_BIN is the empty string", () => {
    expect(resolveDaemonBinOverride({ TP_DAEMON_BIN: "" })).toBeNull();
  });

  test("returns the path for a real executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-daemon-bin-"));
    const bin = join(dir, "tp-daemon");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(resolveDaemonBinOverride({ TP_DAEMON_BIN: bin })).toBe(bin);
  });

  test("throws (naming the path + build hint) when the path does not exist", () => {
    const missing = join(tmpdir(), "tp-daemon-does-not-exist-xyz");
    expect(() => resolveDaemonBinOverride({ TP_DAEMON_BIN: missing })).toThrow(
      /TP_DAEMON_BIN/,
    );
    // Includes the cargo build hint so the operator knows how to recover.
    try {
      resolveDaemonBinOverride({ TP_DAEMON_BIN: missing });
    } catch (e) {
      expect(e instanceof Error && e.message).toContain("cargo build");
      expect(e instanceof Error && e.message).toContain(missing);
    }
  });

  test("throws when the path exists but is not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-daemon-bin-"));
    const notExec = join(dir, "not-exec");
    writeFileSync(notExec, "data");
    chmodSync(notExec, 0o644);
    expect(() => resolveDaemonBinOverride({ TP_DAEMON_BIN: notExec })).toThrow(
      /not an executable file/,
    );
  });
});
