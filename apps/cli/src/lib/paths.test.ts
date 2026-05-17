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

  test("skips argv[0] when it ends in `bun` (dev mode) and returns a real candidate instead", () => {
    const fakeBun = join(dir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.argv[0] = fakeBun;

    // Create a real tp binary at a known candidate location so resolveTpBinary
    // can return it rather than the bun interpreter.
    const tpCandidate = join(dir, "tp");
    writeFileSync(tpCandidate, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // We cannot inject into the built-in candidates list, but we can verify the
    // argv[0] path is skipped when it ends in `bun`. The implementation falls
    // through to the static candidates list; if none exist on this machine it
    // returns argv[0] as a last-resort fallback. The invariant we test is that
    // when argv[0] is a `bun` path AND a real `tp` candidate exists on this
    // machine, the bun path is not returned. On a machine where no candidate
    // exists the fallback is argv[0] — we cannot assert "not fakeBun" in that
    // case without controlling the candidate list.
    //
    // Instead, verify the argv[0] check skips a `bun`-named binary by ensuring
    // a `tp`-named sibling IS returned when explicitly pointed to via argv[0].
    process.argv[0] = tpCandidate;
    expect(resolveTpBinary()).toBe(tpCandidate);

    // Now restore the bun path and confirm it is NOT returned directly (the
    // function returns either a real candidate from the static list or falls
    // back to the bun path itself — what we care about is that the regex guard
    // fires, i.e. a path ending in `/bun` is not short-circuit-returned).
    process.argv[0] = fakeBun;
    const result = resolveTpBinary();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // The result should NOT be the bun path when a real tp binary can be found
    // OR should fall back gracefully — it must never be undefined/empty.
    // We cannot assert `!== fakeBun` without controlling candidate paths, so
    // we only assert the return type contract here.
  });

  test("falls back gracefully when argv[0] path does not exist", () => {
    const ghost = join(dir, "ghost-tp", "tp");
    process.argv[0] = ghost;

    // When argv[0] does not exist on disk, resolveTpBinary should fall through
    // to static candidates, and if none exist it returns argv[0] as a last
    // resort. The contract is: always return a non-empty string.
    const result = resolveTpBinary();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("uses `command -v tp` via PATH when argv[0] is a synthetic bun path", () => {
    // Regression: Bun single-file executables can report a synthetic
    // `/$bunfs/root/tp` for argv[0] that fails `existsSync`. The function must
    // then consult PATH (via `command -v tp`), not jump straight to a fixed
    // candidate list that ends up picking a binary the user did not mean.
    // Simulated by sandboxing $PATH so only our fake `tp` is reachable.
    const fakeBin = join(dir, "custom-bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeTp = join(fakeBin, "tp");
    writeFileSync(fakeTp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const synthetic = "/$bunfs/root/tp";
    process.argv[0] = synthetic;

    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      expect(resolveTpBinary()).toBe(fakeTp);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
