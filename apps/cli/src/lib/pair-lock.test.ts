import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
});
