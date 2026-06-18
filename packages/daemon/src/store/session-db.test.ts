import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SessionDb } from "./session-db";
import { rmRetry } from "./test-helpers";

// Shared-fixture block: SessionDb is opened once and records are cleared
// between tests via resetForTest(). Avoids per-test bun:sqlite open/close
// churn, which is especially expensive on Windows where finalizers lag.
describe("SessionDb", () => {
  let db: SessionDb;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-sdb-"));
    db = new SessionDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.resetForTest();
  });

  afterAll(() => {
    db.close();
    rmRetry(tmpDir);
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
    const after1r0 = after1[0];
    if (after1r0 === undefined) throw new Error("expected after1[0]");
    expect(after1r0.seq).toBe(2);
    expect(after1r0.kind).toBe("event");
    expect(after1r0.ns).toBe("claude");
    expect(after1r0.name).toBe("Stop");

    const after3 = db.getRecordsFrom(3);
    expect(after3.length).toBe(0);
  });

  test("payload is stored and retrieved as bytes", () => {
    const payload = new Uint8Array([0, 1, 2, 255, 128, 0]);
    db.append("io", Date.now(), payload);

    const records = db.getRecordsFrom(0);
    expect(records.length).toBe(1);
    // bun:sqlite returns Buffer, compare contents
    const r0 = records[0];
    if (r0 === undefined) throw new Error("expected records[0]");
    const retrieved = new Uint8Array(r0.payload);
    expect(retrieved).toEqual(payload);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.append("io", Date.now(), Buffer.from(`msg-${i}`));
    }

    const limited = db.getRecordsFrom(0, 3);
    expect(limited.length).toBe(3);
    const lim0 = limited[0];
    if (lim0 === undefined) throw new Error("expected limited[0]");
    expect(lim0.seq).toBe(1);
    const lim2 = limited[2];
    if (lim2 === undefined) throw new Error("expected limited[2]");
    expect(lim2.seq).toBe(3);
  });

  test("stores nullable ns and name fields", () => {
    db.append("io", Date.now(), Buffer.from("test"));
    const records = db.getRecordsFrom(0);
    const rec0 = records[0];
    if (rec0 === undefined) throw new Error("expected records[0]");
    expect(rec0.ns).toBeNull();
    expect(rec0.name).toBeNull();
  });

  test("stores non-null ns and name fields", () => {
    db.append("event", Date.now(), Buffer.from("{}"), "claude", "Stop");
    const records = db.getRecordsFrom(0);
    const rec0 = records[0];
    if (rec0 === undefined) throw new Error("expected records[0]");
    expect(rec0.ns).toBe("claude");
    expect(rec0.name).toBe("Stop");
  });

  describe("getRecordsFiltered", () => {
    test("returns all records with no filters", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
      db.append("meta", 3000, Buffer.from("c"));
      const records = db.getRecordsFiltered({});
      expect(records.length).toBe(3);
    });

    test("filters by kind", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
      db.append("meta", 3000, Buffer.from("c"));
      const events = db.getRecordsFiltered({ kinds: ["event"] });
      expect(events.length).toBe(1);
      const ev0 = events[0];
      if (ev0 === undefined) throw new Error("expected events[0]");
      expect(ev0.kind).toBe("event");
    });

    test("filters by multiple kinds", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
      db.append("meta", 3000, Buffer.from("c"));
      const result = db.getRecordsFiltered({ kinds: ["io", "meta"] });
      expect(result.length).toBe(2);
      const res0 = result[0];
      if (res0 === undefined) throw new Error("expected result[0]");
      expect(res0.kind).toBe("io");
      const res1 = result[1];
      if (res1 === undefined) throw new Error("expected result[1]");
      expect(res1.kind).toBe("meta");
    });

    test("filters by time range (from only)", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("io", 2000, Buffer.from("b"));
      db.append("io", 3000, Buffer.from("c"));
      const result = db.getRecordsFiltered({ from: 2000 });
      expect(result.length).toBe(2);
      const res0 = result[0];
      if (res0 === undefined) throw new Error("expected result[0]");
      expect(res0.ts).toBe(2000);
    });

    test("filters by time range (to only)", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("io", 2000, Buffer.from("b"));
      db.append("io", 3000, Buffer.from("c"));
      const result = db.getRecordsFiltered({ to: 2000 });
      expect(result.length).toBe(2);
      const res1 = result[1];
      if (res1 === undefined) throw new Error("expected result[1]");
      expect(res1.ts).toBe(2000);
    });

    test("filters by time range (from and to)", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("io", 2000, Buffer.from("b"));
      db.append("io", 3000, Buffer.from("c"));
      const result = db.getRecordsFiltered({ from: 1500, to: 2500 });
      expect(result.length).toBe(1);
      const res0 = result[0];
      if (res0 === undefined) throw new Error("expected result[0]");
      expect(res0.ts).toBe(2000);
    });

    test("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        db.append("io", 1000 + i, Buffer.from(`msg-${i}`));
      }
      const result = db.getRecordsFiltered({ limit: 3 });
      expect(result.length).toBe(3);
    });

    test("combines kind filter with time range", () => {
      db.append("io", 1000, Buffer.from("a"));
      db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
      db.append("io", 3000, Buffer.from("c"));
      db.append("event", 4000, Buffer.from("d"), "claude", "Stop");
      const result = db.getRecordsFiltered({ kinds: ["event"], from: 1500 });
      expect(result.length).toBe(2);
      const res0 = result[0];
      if (res0 === undefined) throw new Error("expected result[0]");
      expect(res0.ts).toBe(2000);
      const res1 = result[1];
      if (res1 === undefined) throw new Error("expected result[1]");
      expect(res1.ts).toBe(4000);
    });

    test("default limit is 50000", () => {
      db.append("io", 1000, Buffer.from("a"));
      const result = db.getRecordsFiltered({});
      expect(result.length).toBe(1);
    });
  });
});
