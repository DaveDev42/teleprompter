import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Windows-safe rm: retries on EBUSY (SQLite WAL handles). */
function rmRetry(path: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
        Bun.sleepSync(50);
        continue;
      }
      throw err;
    }
  }
}

describe("tp status (store-backed)", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-status-test-"));
  });

  afterEach(() => {
    rmRetry(storeDir);
  });

  test("listSessions returns an array on a fresh store", () => {
    const store = new Store(storeDir);
    const sessions = store.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
    store.close();
  });

  test("listSessions reflects a seeded session", () => {
    const seed = new Store(storeDir);
    seed.createSession("test-sid", "/tmp/some-cwd");
    seed.close();

    const store = new Store(storeDir);
    const sessions = store.listSessions();
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.sid).toBe("test-sid");
    expect(s.cwd).toBe("/tmp/some-cwd");
    expect(typeof s.last_seq).toBe("number");
    store.close();
  });
});
