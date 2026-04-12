import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { backdateSession, rmRetry } from "./test-helpers";

// Shared-fixture block: Store is opened once, metadata reset between tests.
// Each test uses unique sids so residual on-disk .sqlite files from prior
// tests never collide. Avoids expensive bun:sqlite open/close per test,
// especially on Windows.
describe("Store session cleanup", () => {
  let vault: Store;
  let storeDir: string;

  beforeAll(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "tp-vault-cleanup-"));
    vault = new Store(storeDir);
  });

  afterEach(() => {
    vault.resetForTest();
  });

  afterAll(() => {
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
      const sid = `s-${randomUUID()}`;
      vault.createSession(sid, "/tmp");
      const db = vault.getSessionDb(sid);
      db?.append("io", Date.now(), Buffer.from("test"));

      expect(vault.getSession(sid)).toBeDefined();
      const dbPath = join(storeDir, "sessions", `${sid}.sqlite`);
      expect(existsSync(dbPath)).toBe(true);

      vault.deleteSession(sid);

      expect(vault.getSession(sid)).toBeUndefined();
      expect(existsSync(dbPath)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "pruneOldSessions removes stopped sessions older than threshold",
    () => {
      const old1 = `old-${randomUUID()}`;
      const old2 = `old-${randomUUID()}`;
      const newer = `new-${randomUUID()}`;
      const running = `running-${randomUUID()}`;

      vault.createSession(old1, "/tmp");
      vault.createSession(old2, "/tmp");
      vault.createSession(newer, "/tmp");
      vault.createSession(running, "/tmp");

      vault.updateSessionState(old1, "stopped");
      vault.updateSessionState(old2, "error");
      vault.updateSessionState(newer, "stopped");

      backdateSession(vault, old1, 2 * 60 * 60 * 1000);
      backdateSession(vault, old2, 2 * 60 * 60 * 1000);

      const pruned = vault.pruneOldSessions(60 * 60 * 1000);
      expect(pruned).toBe(2);

      expect(vault.getSession(old1)).toBeUndefined();
      expect(vault.getSession(old2)).toBeUndefined();
      expect(vault.getSession(newer)).toBeDefined();
      expect(vault.getSession(running)).toBeDefined();
    },
  );

  test("pruneOldSessions returns 0 when nothing to prune", () => {
    vault.createSession(`s-${randomUUID()}`, "/tmp");
    const pruned = vault.pruneOldSessions(60 * 60 * 1000);
    expect(pruned).toBe(0);
  });

  test("pruneOldSessions does not remove sessions within TTL", () => {
    const sid = `recent-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "stopped");
    // updated_at is now (just created), TTL is 7 days
    const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(0);
    expect(vault.getSession(sid)).toBeDefined();
  });

  // Skipped on Windows CI: pruneOldSessions iterates deleteSession across
  // multiple sessions, which on Windows exhausts the unlinkRetry budget per
  // iteration due to bun:sqlite finalizer lag. Covered by macOS/Linux CI.
  test.skipIf(process.platform === "win32")(
    "pruneOldSessions removes error sessions beyond TTL",
    () => {
      const sid = `err-old-${randomUUID()}`;
      vault.createSession(sid, "/tmp");
      vault.updateSessionState(sid, "error");

      backdateSession(vault, sid, 8 * 24 * 60 * 60 * 1000);

      const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(1);
      expect(vault.getSession(sid)).toBeUndefined();
    },
  );
});
