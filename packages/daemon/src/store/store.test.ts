import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";
import { rmRetry } from "./test-helpers";

// Shared-fixture block: Store is opened once and metadata is reset between
// tests. Each test uses a unique sid (randomUUID) so leftover .sqlite files
// from prior tests cannot interfere with assertions. This avoids per-test
// bun:sqlite open/close churn, which is especially expensive on Windows.
describe("Store (shared fixture)", () => {
  let storeDir: string;
  let vault: Store;

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-vault-test-"));
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
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
});

// Isolated fixture: this test exercises Store close/reopen, so it cannot
// share state with the block above.
describe("Store (isolated)", () => {
  test("getSessionDb reopens existing db", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tp-vault-reopen-"));
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
    let vault = new Store(storeDir);
    try {
      const db = vault.createSession("s9", "/tmp");
      db.append("io", Date.now(), new TextEncoder().encode("data"));

      vault.close();
      vault = new Store(storeDir);

      const db2 = vault.getSessionDb("s9");
      if (!db2) throw new Error("expected db2");
      const records = db2.getRecordsFrom(0);
      expect(records.length).toBe(1);
    } finally {
      vault.close();
      rmRetry(storeDir);
    }
  });
});
