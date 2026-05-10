import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { resolveTpBinary } from "./paths";

describe("resolveTpBinary", () => {
  let dir: string;
  let originalArgv0: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tp-paths-"));
    originalArgv0 = process.argv[0]!;
  });

  afterEach(() => {
    process.argv[0] = originalArgv0;
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns argv[0] when it points at a real binary named `tp`", () => {
    const fake = join(dir, "tp");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.argv[0] = fake;

    expect(resolveTpBinary()).toBe(fake);
  });

  test("matches `/tp` at any depth (brew, ~/.local, custom dirs)", () => {
    const brewLike = join(dir, "opt", "homebrew", "bin", "tp");
    mkdirSync(dirname(brewLike), { recursive: true });
    writeFileSync(brewLike, "binary", { mode: 0o755 });
    process.argv[0] = brewLike;

    expect(resolveTpBinary()).toBe(brewLike);
  });

  test("does not accept argv[0] when it ends in `bun` (dev mode)", () => {
    const fakeBun = join(dir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.argv[0] = fakeBun;

    // Must not return the bun binary as the tp path. Falls through to the
    // candidates list (which scans real /opt/homebrew etc.) so the result
    // varies per machine — the contract is "some non-empty string", not a
    // specific path. The critical invariant is `result !== fakeBun`.
    const result = resolveTpBinary();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe(fakeBun);
  });

  test("does not accept argv[0] when the path does not exist", () => {
    const ghost = join(dir, "ghost-tp", "tp");
    process.argv[0] = ghost;

    const result = resolveTpBinary();
    expect(result).not.toBe(ghost);
  });
});
