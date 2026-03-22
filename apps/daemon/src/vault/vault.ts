import { Database } from "bun:sqlite";
import { join } from "path";
import { SESSIONS_DDL, PRAGMAS } from "./schema";
import { SessionDb } from "./session-db";
import { getVaultDir } from "./config";
import type { SessionState, SID } from "@teleprompter/protocol";

export interface SessionMeta {
  sid: string;
  state: string;
  worktree_path: string | null;
  cwd: string;
  created_at: number;
  updated_at: number;
  claude_version: string | null;
  last_seq: number;
}

export class Vault {
  private metaDb: Database;
  private sessionDbs = new Map<string, SessionDb>();
  private vaultDir: string;

  private createStmt: ReturnType<Database["prepare"]>;
  private updateStateStmt: ReturnType<Database["prepare"]>;
  private updateLastSeqStmt: ReturnType<Database["prepare"]>;
  private getSessionStmt: ReturnType<Database["prepare"]>;
  private listSessionsStmt: ReturnType<Database["prepare"]>;

  constructor(vaultDir?: string) {
    this.vaultDir = vaultDir ?? getVaultDir();
    this.metaDb = new Database(join(this.vaultDir, "sessions.sqlite"));

    for (const pragma of PRAGMAS) {
      this.metaDb.run(pragma);
    }
    this.metaDb.run(SESSIONS_DDL);

    this.createStmt = this.metaDb.prepare(
      "INSERT INTO sessions (sid, state, worktree_path, cwd, created_at, updated_at, claude_version, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    );
    this.updateStateStmt = this.metaDb.prepare(
      "UPDATE sessions SET state = ?, updated_at = ? WHERE sid = ?",
    );
    this.updateLastSeqStmt = this.metaDb.prepare(
      "UPDATE sessions SET last_seq = ?, updated_at = ? WHERE sid = ?",
    );
    this.getSessionStmt = this.metaDb.prepare(
      "SELECT * FROM sessions WHERE sid = ?",
    );
    this.listSessionsStmt = this.metaDb.prepare(
      "SELECT * FROM sessions ORDER BY created_at DESC",
    );
  }

  createSession(
    sid: SID,
    cwd: string,
    worktreePath?: string,
    claudeVersion?: string,
  ): SessionDb {
    const now = Date.now();
    this.createStmt.run(
      sid,
      "running",
      worktreePath ?? null,
      cwd,
      now,
      now,
      claudeVersion ?? null,
    );

    const dbPath = join(this.vaultDir, "sessions", `${sid}.sqlite`);
    const sessionDb = new SessionDb(dbPath);
    this.sessionDbs.set(sid, sessionDb);
    return sessionDb;
  }

  getSessionDb(sid: SID): SessionDb | undefined {
    if (this.sessionDbs.has(sid)) {
      return this.sessionDbs.get(sid)!;
    }

    // Try opening existing db
    const dbPath = join(this.vaultDir, "sessions", `${sid}.sqlite`);
    try {
      const sessionDb = new SessionDb(dbPath);
      this.sessionDbs.set(sid, sessionDb);
      return sessionDb;
    } catch {
      return undefined;
    }
  }

  updateSessionState(sid: SID, state: SessionState): void {
    this.updateStateStmt.run(state, Date.now(), sid);
  }

  updateLastSeq(sid: SID, seq: number): void {
    this.updateLastSeqStmt.run(seq, Date.now(), sid);
  }

  getSession(sid: SID): SessionMeta | undefined {
    return (this.getSessionStmt.get(sid) as SessionMeta) ?? undefined;
  }

  listSessions(): SessionMeta[] {
    return this.listSessionsStmt.all() as SessionMeta[];
  }

  close(): void {
    for (const db of this.sessionDbs.values()) {
      db.close();
    }
    this.sessionDbs.clear();
    this.metaDb.close();
  }
}
