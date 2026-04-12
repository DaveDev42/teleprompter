import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { backdateSession, rmRetry } from "./test-helpers";

// Windows `bun:sqlite` defers OS handle release to its GC finalizer, and
// the subsequent `unlink` retry loop (`Store.unlinkRetry`) can legitimately
// take several seconds per session on the Windows CI runner. Extend the
// per-test timeout on Windows so slow-but-correct cleanup doesn't flake.
const WIN_TIMEOUT = process.platform === "win32" ? 30_000 : 5_000;

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

  test(
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
    WIN_TIMEOUT,
  );

  test(
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
    WIN_TIMEOUT,
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

  test(
    "pruneOldSessions removes error sessions beyond TTL",
    () => {
      vault.createSession("err-old", "/tmp");
      vault.updateSessionState("err-old", "error");

      backdateSession(vault, "err-old", 8 * 24 * 60 * 60 * 1000);

      const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(1);
      expect(vault.getSession("err-old")).toBeUndefined();
    },
    WIN_TIMEOUT,
  );
});
