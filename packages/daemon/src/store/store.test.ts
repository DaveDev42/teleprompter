import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "./store";

describe("Store", () => {
  let storeDir: string;
  let vault: Store;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-vault-test-"));
    // Create sessions subdirectory
    const { mkdirSync } = require("fs");
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
    vault = new Store(storeDir);
  });

  afterEach(() => {
    vault.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  test("createSession and getSession", () => {
    vault.createSession("s1", "/tmp/project", "/tmp/wt", "1.0.0");

    const session = vault.getSession("s1");
    if (!session) throw new Error("expected session");
    expect(session.sid).toBe("s1");
    expect(session.state).toBe("running");
    expect(session.cwd).toBe("/tmp/project");
    expect(session.worktree_path).toBe("/tmp/wt");
    expect(session.claude_version).toBe("1.0.0");
    expect(session.last_seq).toBe(0);
  });

  test("append records and retrieve", () => {
    const db = vault.createSession("s2", "/tmp");

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
    const db = vault.createSession("s3", "/tmp");

    expect(db.getLastSeq()).toBe(0);

    db.append("io", Date.now(), new TextEncoder().encode("a"));
    db.append("io", Date.now(), new TextEncoder().encode("b"));
    db.append("io", Date.now(), new TextEncoder().encode("c"));

    expect(db.getLastSeq()).toBe(3);
  });

  test("updateSessionState", () => {
    vault.createSession("s4", "/tmp");
    vault.updateSessionState("s4", "stopped");

    const session = vault.getSession("s4");
    if (!session) throw new Error("expected session");
    expect(session.state).toBe("stopped");
  });

  test("updateLastSeq", () => {
    vault.createSession("s5", "/tmp");
    vault.updateLastSeq("s5", 42);

    const session = vault.getSession("s5");
    if (!session) throw new Error("expected session");
    expect(session.last_seq).toBe(42);
  });

  test("listSessions", () => {
    vault.createSession("s6", "/tmp/a");
    vault.createSession("s7", "/tmp/b");
    vault.createSession("s8", "/tmp/c");

    const sessions = vault.listSessions();
    expect(sessions.length).toBe(3);
  });

  test("getSessionDb reopens existing db", () => {
    const db = vault.createSession("s9", "/tmp");
    db.append("io", Date.now(), new TextEncoder().encode("data"));

    // Close and reopen
    vault.close();
    vault = new Store(storeDir);

    const db2 = vault.getSessionDb("s9");
    if (!db2) throw new Error("expected db2");
    const records = db2.getRecordsFrom(0);
    expect(records.length).toBe(1);
  });

  test("getSession returns undefined for nonexistent", () => {
    expect(vault.getSession("nonexistent")).toBeUndefined();
  });
});
