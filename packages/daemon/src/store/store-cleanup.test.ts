import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "crypto";
import { existsSync, rmSync, writeFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { backdateSession, rmRetry } from "./test-helpers";

// Shared-fixture block: Store is opened once, metadata reset between tests.
// Each test uses unique sids so residual on-disk .sqlite files from prior
// tests never collide. Avoids expensive bun:sqlite open/close per test.
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

  test("deleteSession removes metadata and db file", () => {
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
  });

  test("deleteSession removes the WAL/SHM sidecars, not just the main file", () => {
    // Session DBs run in WAL mode, so writing creates `${sid}.sqlite-wal` and
    // `${sid}.sqlite-shm`. db.close() does not reliably remove them, so
    // deleteSession must unlink them explicitly — otherwise every delete/prune
    // orphans two sidecar files forever. Write through getSessionDb and DO NOT
    // close the db before delete, reproducing the real leak condition where the
    // sidecars are still present on disk at unlink time.
    const sid = `wal-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    const db = vault.getSessionDb(sid);
    // Several appends to make the WAL non-trivially populated.
    for (let i = 0; i < 8; i++) {
      db?.append("io", Date.now(), Buffer.from(`payload-${i}`));
    }

    const base = join(storeDir, "sessions", `${sid}.sqlite`);
    expect(existsSync(base)).toBe(true);
    // WAL mode must have produced at least one sidecar for this test to be
    // meaningful; assert that so the test fails loudly if WAL is ever disabled.
    expect(existsSync(`${base}-wal`) || existsSync(`${base}-shm`)).toBe(true);

    vault.deleteSession(sid);

    expect(existsSync(base)).toBe(false);
    expect(existsSync(`${base}-wal`)).toBe(false);
    expect(existsSync(`${base}-shm`)).toBe(false);
  });

  test("sweepOrphanedSidecars removes orphaned -wal/-shm, spares live + base-present sidecars", () => {
    // Simulate the leak left by an older daemon build: a -wal and -shm whose
    // base `.sqlite` was already unlinked. The sweep must remove these but must
    // NOT touch (a) a sidecar whose base file still exists (a real, intact DB)
    // or (b) a live open session's sidecar (removing an open WAL drops writes).
    const sessionsDir = join(storeDir, "sessions");

    // (1) Orphaned sidecars — base does NOT exist.
    const orphan = `orphan-${randomUUID()}`;
    const orphanBase = join(sessionsDir, `${orphan}.sqlite`);
    writeFileSync(`${orphanBase}-wal`, "stale-wal");
    writeFileSync(`${orphanBase}-shm`, "stale-shm");
    expect(existsSync(orphanBase)).toBe(false);

    // (2) Base-present sidecar — a synthetic .sqlite + its -wal. Must be spared.
    const intact = `intact-${randomUUID()}`;
    const intactBase = join(sessionsDir, `${intact}.sqlite`);
    writeFileSync(intactBase, "main-db");
    writeFileSync(`${intactBase}-wal`, "live-wal");

    // (3) Live open session — write through getSessionDb without closing so its
    // sidecars exist on disk and the sid is in the open-db map.
    const live = `live-${randomUUID()}`;
    vault.createSession(live, "/tmp");
    const liveDb = vault.getSessionDb(live);
    for (let i = 0; i < 8; i++) {
      liveDb?.append("io", Date.now(), Buffer.from(`live-${i}`));
    }
    const liveBase = join(sessionsDir, `${live}.sqlite`);

    const removed = vault.sweepOrphanedSidecars();

    // Only the two orphaned sidecars are removed.
    expect(removed).toBe(2);
    expect(existsSync(`${orphanBase}-wal`)).toBe(false);
    expect(existsSync(`${orphanBase}-shm`)).toBe(false);

    // Base-present sidecar untouched (its main file is still there).
    expect(existsSync(intactBase)).toBe(true);
    expect(existsSync(`${intactBase}-wal`)).toBe(true);

    // Live session's main file and sidecars untouched.
    expect(existsSync(liveBase)).toBe(true);

    // Cleanup the synthetic fixtures so they don't leak into later tests.
    vault.deleteSession(live);
    rmSync(intactBase, { force: true });
    rmSync(`${intactBase}-wal`, { force: true });
  });

  test("sweepOrphanedSidecars returns 0 when there are no orphans", () => {
    // A clean store (resetForTest ran in afterEach) has no stray sidecars.
    expect(vault.sweepOrphanedSidecars()).toBe(0);
  });

  test("pruneOldSessions removes stopped sessions older than threshold", () => {
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
  });

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

  test("pruneOldSessions removes error sessions beyond TTL", () => {
    const sid = `err-old-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "error");

    backdateSession(vault, sid, 8 * 24 * 60 * 60 * 1000);

    const pruned = vault.pruneOldSessions(7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(vault.getSession(sid)).toBeUndefined();
  });

  // ── Data-loss guard: zero / negative / NaN maxAgeMs must be a no-op ──────
  //
  // Without this guard, maxAgeMs <= 0 causes cutoff >= Date.now(), so the SQL
  // predicate `updated_at < cutoff` would match EVERY stopped session and
  // silently wipe all session history (e.g. TP_PRUNE_TTL_DAYS=0 or a typo).

  test("pruneOldSessions(0) is a no-op — returns 0 and deletes nothing", () => {
    const sid = `stopped-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "stopped");
    // Backdate to make it look old enough to prune under any real TTL
    backdateSession(vault, sid, 30 * 24 * 60 * 60 * 1000);

    const pruned = vault.pruneOldSessions(0);

    expect(pruned).toBe(0);
    expect(vault.getSession(sid)).toBeDefined();
  });

  test("pruneOldSessions(-1) is a no-op — returns 0 and deletes nothing", () => {
    const sid = `stopped-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "stopped");
    backdateSession(vault, sid, 30 * 24 * 60 * 60 * 1000);

    const pruned = vault.pruneOldSessions(-1);

    expect(pruned).toBe(0);
    expect(vault.getSession(sid)).toBeDefined();
  });

  test("pruneOldSessions(NaN) is a no-op — returns 0 and deletes nothing", () => {
    const sid = `stopped-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "stopped");
    backdateSession(vault, sid, 30 * 24 * 60 * 60 * 1000);

    const pruned = vault.pruneOldSessions(Number.NaN);

    expect(pruned).toBe(0);
    expect(vault.getSession(sid)).toBeDefined();
  });
});
