import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionDb } from "./session-db";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionDb", () => {
  let db: SessionDb;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-sdb-"));
    db = new SessionDb(join(tmpDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("starts with lastSeq = 0", () => {
    expect(db.getLastSeq()).toBe(0);
  });

  test("append returns monotonically increasing seq", () => {
    const seq1 = db.append("io", Date.now(), Buffer.from("hello"));
    const seq2 = db.append("io", Date.now(), Buffer.from("world"));
    const seq3 = db.append("event", Date.now(), Buffer.from("{}"));
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);
  });

  test("getLastSeq reflects appended records", () => {
    db.append("io", Date.now(), Buffer.from("a"));
    db.append("io", Date.now(), Buffer.from("b"));
    db.append("io", Date.now(), Buffer.from("c"));
    expect(db.getLastSeq()).toBe(3);
  });

  test("getRecordsFrom returns records after cursor", () => {
    db.append("io", 1000, Buffer.from("first"));
    db.append("event", 2000, Buffer.from("second"), "claude", "Stop");
    db.append("io", 3000, Buffer.from("third"));

    const all = db.getRecordsFrom(0);
    expect(all.length).toBe(3);

    const after1 = db.getRecordsFrom(1);
    expect(after1.length).toBe(2);
    expect(after1[0].seq).toBe(2);
    expect(after1[0].kind).toBe("event");
    expect(after1[0].ns).toBe("claude");
    expect(after1[0].name).toBe("Stop");

    const after3 = db.getRecordsFrom(3);
    expect(after3.length).toBe(0);
  });

  test("payload is stored and retrieved as bytes", () => {
    const payload = new Uint8Array([0, 1, 2, 255, 128, 0]);
    db.append("io", Date.now(), payload);

    const records = db.getRecordsFrom(0);
    expect(records.length).toBe(1);
    // bun:sqlite returns Buffer, compare contents
    const retrieved = new Uint8Array(records[0].payload);
    expect(retrieved).toEqual(payload);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.append("io", Date.now(), Buffer.from(`msg-${i}`));
    }

    const limited = db.getRecordsFrom(0, 3);
    expect(limited.length).toBe(3);
    expect(limited[0].seq).toBe(1);
    expect(limited[2].seq).toBe(3);
  });

  test("stores nullable ns and name fields", () => {
    db.append("io", Date.now(), Buffer.from("test"));
    const records = db.getRecordsFrom(0);
    expect(records[0].ns).toBeNull();
    expect(records[0].name).toBeNull();
  });

  test("stores non-null ns and name fields", () => {
    db.append("event", Date.now(), Buffer.from("{}"), "claude", "Stop");
    const records = db.getRecordsFrom(0);
    expect(records[0].ns).toBe("claude");
    expect(records[0].name).toBe("Stop");
  });
});
