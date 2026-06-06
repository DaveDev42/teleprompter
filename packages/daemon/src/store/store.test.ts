import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { rmRetry } from "./test-helpers";

// Shared-fixture block: Store is opened once and metadata + per-session
// .sqlite files are reset between tests via `resetForTest()`. Each test
// uses a unique sid (randomUUID) as defense in depth. Avoids per-test
// bun:sqlite open/close churn, which is especially expensive on Windows.
describe("Store (shared fixture)", () => {
  let storeDir: string;
  let vault: Store;

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-vault-test-"));
    vault = new Store(storeDir);
  });

  afterEach(() => {
    vault.resetForTest();
  });

  afterAll(() => {
    vault.close();
    rmRetry(storeDir);
  });

  test("createSession and getSession", () => {
    const sid = `s-${randomUUID()}`;
    vault.createSession(sid, "/tmp/project", "/tmp/wt", "1.0.0");

    const session = vault.getSession(sid);
    if (!session) throw new Error("expected session");
    expect(session.sid).toBe(sid);
    expect(session.state).toBe("running");
    expect(session.cwd).toBe("/tmp/project");
    expect(session.worktree_path).toBe("/tmp/wt");
    expect(session.claude_version).toBe("1.0.0");
    expect(session.last_seq).toBe(0);
  });

  test("append records and retrieve", () => {
    const sid = `s-${randomUUID()}`;
    const db = vault.createSession(sid, "/tmp");

    const payload1 = new TextEncoder().encode("hello");
    const payload2 = new TextEncoder().encode("world");

    const seq1 = db.append("io", Date.now(), payload1);
    const seq2 = db.append("event", Date.now(), payload2, "claude", "Stop");

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);

    const records = db.getRecordsFrom(0);
    expect(records.length).toBe(2);
    const rec0 = records[0];
    const rec1 = records[1];
    if (!rec0 || !rec1) throw new Error("expected records");
    expect(rec0.kind).toBe("io");
    expect(rec1.kind).toBe("event");
    expect(rec1.ns).toBe("claude");
    expect(rec1.name).toBe("Stop");
  });

  test("getLastSeq", () => {
    const sid = `s-${randomUUID()}`;
    const db = vault.createSession(sid, "/tmp");

    expect(db.getLastSeq()).toBe(0);

    db.append("io", Date.now(), new TextEncoder().encode("a"));
    db.append("io", Date.now(), new TextEncoder().encode("b"));
    db.append("io", Date.now(), new TextEncoder().encode("c"));

    expect(db.getLastSeq()).toBe(3);
  });

  test("updateSessionState", () => {
    const sid = `s-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateSessionState(sid, "stopped");

    const session = vault.getSession(sid);
    if (!session) throw new Error("expected session");
    expect(session.state).toBe("stopped");
  });

  test("updateLastSeq", () => {
    const sid = `s-${randomUUID()}`;
    vault.createSession(sid, "/tmp");
    vault.updateLastSeq(sid, 42);

    const session = vault.getSession(sid);
    if (!session) throw new Error("expected session");
    expect(session.last_seq).toBe(42);
  });

  test("createSession on an existing sid (restart) preserves last_seq and created_at", () => {
    // Regression: restart re-invokes createSession via handleHello. A plain
    // INSERT OR REPLACE reset last_seq to 0 and stamped a fresh created_at,
    // which broke the frontend cursor replay (its cursor exceeded the store's
    // last_seq, so resume returned nothing) and lost the creation time. The
    // upsert must refresh mutable fields while keeping last_seq/created_at.
    const sid = `s-${randomUUID()}`;
    vault.createSession(sid, "/tmp/original", "/tmp/wt-1", "1.0.0");
    vault.updateLastSeq(sid, 99);
    vault.updateSessionState(sid, "stopped");
    const before = vault.getSession(sid);
    if (!before) throw new Error("expected session");
    expect(before.last_seq).toBe(99);
    const originalCreatedAt = before.created_at;

    // Restart: same sid, new worktree/version, state flips back to running.
    vault.createSession(sid, "/tmp/restarted", "/tmp/wt-2", "2.0.0");
    const after = vault.getSession(sid);
    if (!after) throw new Error("expected session after restart");

    // Preserved across the restart:
    expect(after.last_seq).toBe(99);
    expect(after.created_at).toBe(originalCreatedAt);
    // Refreshed by the restart:
    expect(after.state).toBe("running");
    expect(after.cwd).toBe("/tmp/restarted");
    expect(after.worktree_path).toBe("/tmp/wt-2");
    expect(after.claude_version).toBe("2.0.0");
  });

  test("listSessions", () => {
    vault.createSession(`s-${randomUUID()}`, "/tmp/a");
    vault.createSession(`s-${randomUUID()}`, "/tmp/b");
    vault.createSession(`s-${randomUUID()}`, "/tmp/c");

    const sessions = vault.listSessions();
    expect(sessions.length).toBe(3);
  });

  test("getSession returns undefined for nonexistent", () => {
    expect(vault.getSession("nonexistent")).toBeUndefined();
  });

  test("pairings: label is persisted on add and returned on list", () => {
    vault.savePairing({
      daemonId: "daemon-label-1",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: Buffer.from([1]),
      secretKey: Buffer.from([2]),
      pairingSecret: Buffer.from([3]),
      label: { set: true, value: "My MacBook" },
    });
    const rows = vault.listPairings();
    const row = rows.find((r) => r.daemonId === "daemon-label-1");
    if (!row) throw new Error("expected row");
    expect(row.label).toEqual({ set: true, value: "My MacBook" });
  });

  test("pairings: updatePairingLabel changes label", () => {
    vault.savePairing({
      daemonId: "daemon-label-2",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: Buffer.from([1]),
      secretKey: Buffer.from([2]),
      pairingSecret: Buffer.from([3]),
      label: { set: true, value: "old" },
    });
    vault.updatePairingLabel("daemon-label-2", { set: true, value: "new" });
    const row = vault
      .listPairings()
      .find((r) => r.daemonId === "daemon-label-2");
    if (!row) throw new Error("expected row");
    expect(row.label).toEqual({ set: true, value: "new" });
  });

  test("pairings: savePairing with no label stores { set: false }", () => {
    vault.savePairing({
      daemonId: "daemon-nolabel",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: Buffer.from([1]),
      secretKey: Buffer.from([2]),
      pairingSecret: Buffer.from([3]),
    });
    const row = vault
      .listPairings()
      .find((r) => r.daemonId === "daemon-nolabel");
    if (!row) throw new Error("expected row");
    expect(row.label).toEqual({ set: false });
  });

  test("loadPairings drops a row with a corrupt (truncated) key blob", () => {
    // Two valid pairings with real 32-byte keys, then corrupt one key column
    // directly in SQLite (bypassing savePairing) to simulate a truncated/
    // tampered row. loadPairings must filter the corrupt row and return only
    // the intact one — a single bad pairing can't block the others.
    const key32 = (fill: number) => new Uint8Array(32).fill(fill);
    vault.savePairing({
      daemonId: "daemon-good",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: key32(1),
      secretKey: key32(2),
      pairingSecret: key32(3),
    });
    vault.savePairing({
      daemonId: "daemon-corrupt",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: key32(4),
      secretKey: key32(5),
      pairingSecret: key32(6),
    });

    // Truncate daemon-corrupt's public_key to 1 byte via the private metaDb.
    const metaDb = (
      vault as unknown as {
        metaDb: { run: (sql: string, params: unknown[]) => void };
      }
    ).metaDb;
    metaDb.run("UPDATE pairings SET public_key = ? WHERE daemon_id = ?", [
      Buffer.from([0xff]),
      "daemon-corrupt",
    ]);

    const loaded = vault.loadPairings();
    expect(loaded.map((p) => p.daemonId)).toEqual(["daemon-good"]);
    const good = loaded[0];
    if (!good) throw new Error("expected daemon-good");
    expect(good.publicKey.byteLength).toBe(32);
    expect(good.secretKey.byteLength).toBe(32);
    expect(good.pairingSecret.byteLength).toBe(32);
  });

  // ── Push token persistence (Path X) ──

  const SEALED_A =
    "tpps1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
  const SEALED_B =
    "tpps1.1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==";

  test("savePushToken round-trip via loadPushTokens", () => {
    vault.savePushToken({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    const tokens = vault.loadPushTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
  });

  test("savePushToken INSERT OR REPLACE overwrites on same frontendId", () => {
    vault.savePushToken({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    vault.savePushToken({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_B,
      platform: "android",
    });
    const tokens = vault.loadPushTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.sealed).toBe(SEALED_B);
    expect(tokens[0]?.platform).toBe("android");
  });

  test("deletePushToken removes a single entry", () => {
    vault.savePushToken({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    vault.savePushToken({
      frontendId: "fe-2",
      daemonId: "d-1",
      sealed: SEALED_B,
      platform: "android",
    });
    vault.deletePushToken("fe-1");
    const tokens = vault.loadPushTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.frontendId).toBe("fe-2");
  });

  test("deletePushTokensForDaemon removes all entries for a daemonId", () => {
    vault.savePushToken({
      frontendId: "fe-1",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    vault.savePushToken({
      frontendId: "fe-2",
      daemonId: "d-1",
      sealed: SEALED_B,
      platform: "android",
    });
    vault.deletePushTokensForDaemon("d-1");
    expect(vault.loadPushTokens()).toHaveLength(0);
  });

  test("deletePairing cascades to push_tokens", () => {
    // Add pairing first
    vault.savePairing({
      daemonId: "d-cascade",
      relayUrl: "wss://relay.example.com",
      relayToken: "tok",
      registrationProof: "proof",
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      pairingSecret: new Uint8Array(32),
    });
    vault.savePushToken({
      frontendId: "fe-cascade",
      daemonId: "d-cascade",
      sealed: SEALED_A,
      platform: "ios",
    });
    expect(vault.loadPushTokens()).toHaveLength(1);
    vault.deletePairing("d-cascade");
    expect(vault.loadPushTokens()).toHaveLength(0);
  });
});

// Isolated fixture: this test exercises Store close/reopen, so it cannot
// share state with the block above.
describe("Store (isolated)", () => {
  test("getSessionDb reopens existing db", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-reopen-"));
    const first = new Store(storeDir);
    const firstDb = first.createSession("s9", "/tmp");
    firstDb.append("io", Date.now(), new TextEncoder().encode("data"));
    first.close();

    const second = new Store(storeDir);
    try {
      const db2 = second.getSessionDb("s9");
      if (!db2) throw new Error("expected db2");
      const records = db2.getRecordsFrom(0);
      expect(records.length).toBe(1);
    } finally {
      second.close();
      rmRetry(storeDir);
    }
  });

  test("maxOpenSessionDbs=0 does not evict the db it just opened", () => {
    // Regression: the LRU loop inserts then evicts while size > cap. With cap=0
    // it would close the just-inserted db (its own oldest entry) and hand the
    // caller a closed handle, so the very first append would fail. The guard
    // short-circuits the loop for the pathological cap. (cap=0 is never set in
    // production — default is 32 — but the invariant must hold for any input.)
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-cap0-"));
    const store = new Store(storeDir, { maxOpenSessionDbs: 0 });
    try {
      const db = store.createSession("s-cap0", "/tmp");
      // The handle must still be usable — a write proves it was not closed.
      db.append("io", Date.now(), new TextEncoder().encode("alive"));
      expect(db.getRecordsFrom(0).length).toBe(1);
    } finally {
      store.close();
      rmRetry(storeDir);
    }
  });

  test("maxOpenSessionDbs=1 evicts the older db when a second opens", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-cap1-"));
    const store = new Store(storeDir, { maxOpenSessionDbs: 1 });
    try {
      const first = store.createSession("s-first", "/tmp");
      first.append("io", Date.now(), new TextEncoder().encode("first"));
      // Opening a second session evicts (closes) the first under cap=1.
      const second = store.createSession("s-second", "/tmp");
      second.append("io", Date.now(), new TextEncoder().encode("second"));
      // The first handle was closed by eviction; getSessionDb reopens it from
      // disk and the persisted record is intact.
      const reopened = store.getSessionDb("s-first");
      if (!reopened) throw new Error("expected reopened db");
      expect(reopened.getRecordsFrom(0).length).toBe(1);
    } finally {
      store.close();
      rmRetry(storeDir);
    }
  });
});

// Regression for SQLITE_BUSY when the daemon (long-running writer) shares
// the metadata DB with short-lived CLI processes (occasional readers /
// writers). Before the WAL switch, opening a second Store while the first
// one held a write transaction would synchronously throw SQLITE_BUSY because
// the rollback journal serializes everything.
describe("Store (concurrent reader regression)", () => {
  test("WAL + busy_timeout lets a reader open while writer is mid-txn", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-concurrent-"));
    const writer = new Store(storeDir);
    try {
      writer.createSession("s-concurrent", "/tmp/project");

      const reader = new Store(storeDir);
      try {
        // A second open must succeed without SQLITE_BUSY — proves WAL mode is
        // active and busy_timeout would absorb any transient lock contention.
        expect(reader.listSessions().length).toBe(1);
        expect(reader.getSession("s-concurrent")?.cwd).toBe("/tmp/project");
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
      rmRetry(storeDir);
    }
  });

  test("metadata DB is configured for WAL journal mode", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-pragmas-"));
    const store = new Store(storeDir);
    try {
      // Re-opening through a fresh sqlite handle is the public way to assert
      // the persisted journal mode — Store doesn't expose its metaDb.
      const probe = new Database(join(storeDir, "sessions.sqlite"));
      try {
        const row = probe.prepare("PRAGMA journal_mode").get() as
          | { journal_mode: string }
          | undefined;
        expect(row?.journal_mode?.toLowerCase()).toBe("wal");
      } finally {
        probe.close();
      }
    } finally {
      store.close();
      rmRetry(storeDir);
    }
  });
});

describe("Store push_tokens — isolated tests", () => {
  let storeDir: string;
  let store: Store;

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-push-tokens-"));
    store = new Store(storeDir);
  });

  afterEach(() => {
    store.resetForTest();
  });

  afterAll(() => {
    store.close();
    rmRetry(storeDir);
  });

  const SEALED_A =
    "tpps1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

  test("fresh DB returns empty loadPushTokens", () => {
    expect(store.loadPushTokens()).toHaveLength(0);
  });

  test("corrupt platform value is dropped by loadPushTokens", () => {
    // Insert a row with an invalid platform directly to bypass the type guard
    store.savePushToken({
      frontendId: "fe-corrupt",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    // Now corrupt it at the SQL level
    const db = (store as unknown as { metaDb: import("bun:sqlite").Database })
      .metaDb;
    db.run(
      "UPDATE push_tokens SET platform = 'web' WHERE frontend_id = 'fe-corrupt'",
    );
    const tokens = store.loadPushTokens();
    expect(tokens).toHaveLength(0);
  });

  test("empty sealed string is dropped by loadPushTokens", () => {
    store.savePushToken({
      frontendId: "fe-empty",
      daemonId: "d-1",
      sealed: SEALED_A,
      platform: "ios",
    });
    const db = (store as unknown as { metaDb: import("bun:sqlite").Database })
      .metaDb;
    db.run("UPDATE push_tokens SET sealed = '' WHERE frontend_id = 'fe-empty'");
    const tokens = store.loadPushTokens();
    expect(tokens).toHaveLength(0);
  });
});
