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
