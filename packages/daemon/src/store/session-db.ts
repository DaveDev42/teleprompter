import { Database } from "bun:sqlite";
import type { Namespace, RecordKind } from "@teleprompter/protocol";
import { PRAGMAS, RECORDS_DDL } from "./schema";

export interface StoredRecord {
  seq: number;
  kind: RecordKind;
  ts: number;
  ns: string | null;
  name: string | null;
  payload: Uint8Array;
}

export class SessionDb {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private selectStmt: ReturnType<Database["prepare"]>;
  private lastSeqStmt: ReturnType<Database["prepare"]>;

  constructor(path: string) {
    this.db = new Database(path);
    for (const pragma of PRAGMAS) {
      this.db.run(pragma);
    }
    this.db.run(RECORDS_DDL);

    this.insertStmt = this.db.prepare(
      "INSERT INTO records (kind, ts, ns, name, payload) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectStmt = this.db.prepare(
      "SELECT seq, kind, ts, ns, name, payload FROM records WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    this.lastSeqStmt = this.db.prepare(
      "SELECT MAX(seq) as last_seq FROM records",
    );
  }

  append(
    kind: RecordKind,
    ts: number,
    payload: Uint8Array,
    ns?: Namespace,
    name?: string,
  ): number {
    const result = this.insertStmt.run(
      kind,
      ts,
      ns ?? null,
      name ?? null,
      payload,
    );
    return Number(result.lastInsertRowid);
  }

  getRecordsFrom(seq: number, limit = 1000): StoredRecord[] {
    return this.selectStmt.all(seq, limit) as StoredRecord[];
  }

  getRecordsFiltered(opts: {
    kinds?: RecordKind[];
    from?: number;
    to?: number;
    limit?: number;
  }): StoredRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.kinds && opts.kinds.length > 0) {
      conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    if (opts.from !== undefined) {
      conditions.push("ts >= ?");
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      conditions.push("ts <= ?");
      params.push(opts.to);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 50000, 50000);
    const sql = `SELECT seq, kind, ts, ns, name, payload FROM records ${where} ORDER BY seq LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as StoredRecord[];
  }

  getLastSeq(): number {
    const row = this.lastSeqStmt.get() as { last_seq: number | null };
    return row.last_seq ?? 0;
  }

  /**
   * Test-only: clear all records, reset the autoincrement sequence, and
   * truncate the WAL. Designed for shared-fixture test blocks that reuse a
   * single `SessionDb` across tests to avoid per-test open/close churn
   * (especially costly on Windows where `bun:sqlite` finalizers lag).
   */
  resetForTest(): void {
    this.db.run("DELETE FROM records");
    this.db.run("DELETE FROM sqlite_sequence WHERE name='records'");
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Benign: checkpoint can fail if WAL is already truncated or locked.
    }
  }

  close(): void {
    // Checkpoint and truncate WAL so it is emptied before close, letting
    // Windows release the -wal/-shm handles cleanly. Without this, Windows
    // keeps an exclusive handle on the sidecars and subsequent `rm` fails
    // with EBUSY.
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Ignore — checkpoint may fail if another connection holds the db.
    }
    this.db.close();
    // Trigger finalization of the underlying sqlite handle on Windows,
    // where GC-driven cleanup otherwise lingers for many seconds.
    if (process.platform === "win32") {
      Bun.gc(true);
    }
  }
}
