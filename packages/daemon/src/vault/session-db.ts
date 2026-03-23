import { Database } from "bun:sqlite";
import { RECORDS_DDL, PRAGMAS } from "./schema";
import type { RecordKind, Namespace } from "@teleprompter/protocol";

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
    const result = this.insertStmt.run(kind, ts, ns ?? null, name ?? null, payload);
    return Number(result.lastInsertRowid);
  }

  getRecordsFrom(seq: number, limit = 1000): StoredRecord[] {
    return this.selectStmt.all(seq, limit) as StoredRecord[];
  }

  getLastSeq(): number {
    const row = this.lastSeqStmt.get() as { last_seq: number | null };
    return row.last_seq ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
