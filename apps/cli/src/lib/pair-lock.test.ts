import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquirePairLock, releasePairLock } from "./pair-lock";

describe("pair-lock", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("second acquire fails immediately while first holds", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-pair-lock-"));
    const path = join(dir, "pair.lock");

    const release = await acquirePairLock(path);
    expect(release).not.toBeNull();

    const second = await acquirePairLock(path);
    expect(second).toBeNull();

    await releasePairLock(release);

    const third = await acquirePairLock(path);
    expect(third).not.toBeNull();
    await releasePairLock(third);
  });

  test("releasePairLock(null) is a no-op", async () => {
    await expect(releasePairLock(null)).resolves.toBeUndefined();
  });

  test("recovers a stale lock dir left by a crashed holder", async () => {
    // Regression for the v0.1.22 first-run wizard bug: `pkill -9` on a
    // pairing flow leaves `pair.lock.lock/` behind. The previous lock TTL
    // (30s) made the next `tp pair new` block long enough that the user's
    // wizard reported "Another `tp pair new` is already running" instead
    // of recovering. The new TTL is 10s, and we additionally retry inside
    // the stale window so a stale dir whose mtime is already past the
    // threshold can be reclaimed without a second user invocation.
    dir = mkdtempSync(join(tmpdir(), "tp-pair-lock-stale-"));
    const path = join(dir, "pair.lock");

    // Simulate a crashed holder: lock file plus the .lock dir, mtime way
    // in the past so proper-lockfile's stale check kicks in on the very
    // first attempt.
    writeFileSync(path, "");
    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockDir, longAgo, longAgo);

    const release = await acquirePairLock(path);
    expect(release).not.toBeNull();
    await releasePairLock(release);
  }, 20_000);
});
