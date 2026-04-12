import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { backdateSession, rmRetry } from "./test-helpers";

describe("Store session cleanup", () => {
  let vault: Store;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "tp-vault-cleanup-"));
    vault = new Store(storeDir);
  });

  afterEach(async () => {
    vault.close();
    rmRetry(storeDir);
  });

  // Windows `bun:sqlite` holds the underlying OS file handle past
  // `db.close()` until the next GC cycle actually runs the finalizer.
  // `Bun.gc(true)` + a 6-attempt retry releases it in the common case,
  // but on the Windows CI runner under load we still see all retries
  // exhausted — the lock outlives any practical retry budget. Skipped
  // until Bun ships synchronous handle release for sqlite.
  test.skipIf(process.platform === "win32")(
    "deleteSession removes metadata and db file",
    () => {
      vault.createSession("s1", "/tmp");
      const db = vault.getSessionDb("s1");
      db?.append("io", Date.now(), Buffer.from("test"));

      expect(vault.getSession("s1")).toBeDefined();
      const dbPath = join(storeDir, "sessions", "s1.sqlite");
      expect(existsSync(dbPath)).toBe(true);

      vault.deleteSession("s1");

      expect(vault.getSession("s1")).toBeUndefined();
      expect(existsSync(dbPath)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "pruneOldSessions removes stopped sessions older than threshold",
    () => {
      vault.createSession("old-1", "/tmp");
      vault.createSession("old-2", "/tmp");
      vault.createSession("new-1", "/tmp");
      vault.createSession("running-1", "/tmp");

      vault.updateSessionState("old-1", "stopped");
      vault.updateSessionState("old-2", "error");
      vault.updateSessionState("new-1", "stopped");

      backdateSession(vault, "old-1", 2 * 60 * 60 * 1000);
      backdateSession(vault, "old-2", 2 * 60 * 60 * 1000);

      const pruned = vault.pruneOldSessions(60 * 60 * 1000);
      expect(pruned).toBe(2);

      expect(vault.getSession("old-1")).toBeUndefined();
      expect(vault.getSession("old-2")).toBeUndefined();
      expect(vault.getSession("new-1")).toBeDefined();
      expect(vault.getSession("running-1")).toBeDefined();
    },
  );

  test("pruneOldSessions returns 0 when nothing to prune", () => {
    vault.createSession("s1", "/tmp");
    const pruned = vault.pruneOldSessions(60 * 60 * 1000);
    expect(pruned).toBe(0);
  });

  test("pruneOldSessions does not remove sessions within TTL", () => {
    vault.createSession("recent", "/tmp");
    vault.updateSessionState("recent", "stopped");
    // updated_at is now (just created), TTL is 7 days
    const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(0);
    expect(vault.getSession("recent")).toBeDefined();
  });

  // Skipped on Windows CI: pruneOldSessions iterates deleteSession across
  // multiple sessions, which on Windows exhausts the unlinkRetry budget per
  // iteration due to bun:sqlite finalizer lag. Covered by macOS/Linux CI.
  test.skipIf(process.platform === "win32")("pruneOldSessions removes error sessions beyond TTL", () => {
    vault.createSession("err-old", "/tmp");
    vault.updateSessionState("err-old", "error");

    backdateSession(vault, "err-old", 8 * 24 * 60 * 60 * 1000);

    const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(vault.getSession("err-old")).toBeUndefined();
  });
});
