import { Database } from "bun:sqlite";
import {
  createLogger,
  type SessionState,
  type SID,
} from "@teleprompter/protocol";
import { mkdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { getStoreDir } from "./config";
import {
  PAIRINGS_DDL,
  PAIRINGS_MIGRATIONS,
  PRAGMAS,
  SESSIONS_DDL,
} from "./schema";
import { SessionDb } from "./session-db";

const log = createLogger("Store");

export interface PairingSummary {
  daemonId: string;
  relayUrl: string;
  createdAt: number;
  label: string | null;
}

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

/**
 * Soft cap on how many per-session SQLite handles stay open concurrently.
 * Historical sessions accessed once (e.g. via `getRecordsSince`) used to keep
 * their handle alive forever, accumulating fd usage across weeks of a
 * long-running daemon.
 */
const DEFAULT_MAX_OPEN_SESSION_DBS = 32;

export class Store {
  private metaDb: Database;
  /**
   * Insertion-ordered Map doubles as an LRU: every access re-inserts the key,
   * so iteration order reflects least-recent → most-recent.
   */
  private sessionDbs = new Map<string, SessionDb>();
  private readonly maxOpenSessionDbs: number;
  private storeDir: string;

  private createStmt: ReturnType<Database["prepare"]>;
  private updateStateStmt: ReturnType<Database["prepare"]>;
  private updateLastSeqStmt: ReturnType<Database["prepare"]>;
  private getSessionStmt: ReturnType<Database["prepare"]>;
  private listSessionsStmt: ReturnType<Database["prepare"]>;

  constructor(storeDir?: string, opts: { maxOpenSessionDbs?: number } = {}) {
    this.storeDir = storeDir ?? getStoreDir();
    this.maxOpenSessionDbs =
      opts.maxOpenSessionDbs ?? DEFAULT_MAX_OPEN_SESSION_DBS;
    mkdirSync(join(this.storeDir, "sessions"), { recursive: true });
    this.metaDb = new Database(join(this.storeDir, "sessions.sqlite"));

    for (const pragma of PRAGMAS) {
      this.metaDb.run(pragma);
    }
    this.metaDb.run(SESSIONS_DDL);
    this.metaDb.run(PAIRINGS_DDL);
    // Probe the current schema and only run ALTER when columns are missing.
    // Fresh DBs already have `label` from PAIRINGS_DDL; this is strictly for
    // upgrading pre-label databases.
    const existingCols = new Set(
      (
        this.metaDb.prepare("PRAGMA table_info(pairings)").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    // PAIRINGS_MIGRATIONS is intentionally "ADD COLUMN only" until a versioned
    // migrations table exists. Probe before ALTER to avoid noisy duplicate-column errors.
    for (const sql of PAIRINGS_MIGRATIONS) {
      const m = sql.match(/ADD COLUMN\s+(\w+)/i);
      if (m && existingCols.has(m[1]!)) continue;
      try {
        this.metaDb.run(sql);
      } catch (err) {
        // Safety net: if a concurrent open raced us, swallow dup-column errors.
        const msg = (err as Error).message ?? "";
        if (!/duplicate column|already exists/i.test(msg)) throw err;
      }
    }

    this.createStmt = this.metaDb.prepare(
      "INSERT OR REPLACE INTO sessions (sid, state, worktree_path, cwd, created_at, updated_at, claude_version, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
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

    const dbPath = join(this.storeDir, "sessions", `${sid}.sqlite`);
    const sessionDb = new SessionDb(dbPath);
    this.trackSessionDb(sid, sessionDb);
    return sessionDb;
  }

  getSessionDb(sid: SID): SessionDb | undefined {
    const cached = this.sessionDbs.get(sid);
    if (cached) {
      // Touch: re-insert at the tail so iteration order stays LRU.
      this.sessionDbs.delete(sid);
      this.sessionDbs.set(sid, cached);
      return cached;
    }

    // Try opening existing db
    const dbPath = join(this.storeDir, "sessions", `${sid}.sqlite`);
    try {
      const sessionDb = new SessionDb(dbPath);
      this.trackSessionDb(sid, sessionDb);
      return sessionDb;
    } catch {
      return undefined;
    }
  }

  private trackSessionDb(sid: SID, db: SessionDb): void {
    this.sessionDbs.set(sid, db);
    while (this.sessionDbs.size > this.maxOpenSessionDbs) {
      const oldest = this.sessionDbs.keys().next().value;
      if (!oldest) break;
      const evict = this.sessionDbs.get(oldest);
      this.sessionDbs.delete(oldest);
      try {
        evict?.close();
      } catch (err) {
        log.warn(`LRU evict close failed for ${oldest}: ${err}`);
      }
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

  /**
   * Delete a session and its record database.
   */
  deleteSession(sid: SID): void {
    // Close session db if open
    const db = this.sessionDbs.get(sid);
    if (db) {
      db.close();
      this.sessionDbs.delete(sid);
    }

    // Delete metadata
    this.metaDb.run("DELETE FROM sessions WHERE sid = ?", [sid]);

    // Delete session database file
    const dbPath = join(this.storeDir, "sessions", `${sid}.sqlite`);
    this.unlinkRetry(dbPath);
  }

  private unlinkRetry(path: string): void {
    // Retry on transient EBUSY/EPERM (rare on POSIX after db.close()).
    // Budget: 25 + 50 + 100 + 200 + 400 + 800 = 1575 ms across 6 attempts,
    // keeps startAutoCleanup within the default 5000 ms test timeout when
    // it walks several sessions at once.
    const maxAttempts = 6;
    let lastCode: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        unlinkSync(path);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        lastCode = code;
        if (code === "ENOENT") return;
        if (code === "EBUSY" || code === "EPERM") {
          if (attempt === maxAttempts - 1) break;
          Bun.sleepSync(25 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    log.warn(
      `failed to delete ${path} after ${maxAttempts} retries (${lastCode ?? "locked"})`,
    );
  }

  /**
   * Delete all stopped/error sessions older than the given age (ms).
   * Returns the number of sessions pruned.
   */
  pruneOldSessions(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const old = this.metaDb
      .prepare(
        "SELECT sid FROM sessions WHERE state != 'running' AND updated_at < ?",
      )
      .all(cutoff) as { sid: string }[];

    for (const { sid } of old) {
      this.deleteSession(sid);
    }
    return old.length;
  }

  // ── Pairing Persistence ──

  savePairing(data: {
    daemonId: string;
    relayUrl: string;
    relayToken: string;
    registrationProof: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    pairingSecret: Uint8Array;
    label?: string | null;
  }): void {
    this.metaDb
      .prepare(
        `INSERT OR REPLACE INTO pairings
         (daemon_id, relay_url, relay_token, registration_proof, public_key, secret_key, pairing_secret, created_at, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.daemonId,
        data.relayUrl,
        data.relayToken,
        data.registrationProof,
        data.publicKey,
        data.secretKey,
        data.pairingSecret,
        Date.now(),
        data.label ?? null,
      );
  }

  updatePairingLabel(daemonId: string, label: string | null): void {
    this.metaDb.run("UPDATE pairings SET label = ? WHERE daemon_id = ?", [
      label,
      daemonId,
    ]);
  }

  loadPairings(): Array<{
    daemonId: string;
    relayUrl: string;
    relayToken: string;
    registrationProof: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    pairingSecret: Uint8Array;
    label: string | null;
  }> {
    const rows = this.metaDb
      .prepare("SELECT * FROM pairings ORDER BY created_at ASC")
      .all() as Array<{
      daemon_id: string;
      relay_url: string;
      relay_token: string;
      registration_proof: string;
      public_key: Buffer;
      secret_key: Buffer;
      pairing_secret: Buffer;
      created_at: number;
      label: string | null;
    }>;

    return rows.map((r) => ({
      daemonId: r.daemon_id,
      relayUrl: r.relay_url,
      relayToken: r.relay_token,
      registrationProof: r.registration_proof,
      publicKey: new Uint8Array(r.public_key),
      secretKey: new Uint8Array(r.secret_key),
      pairingSecret: new Uint8Array(r.pairing_secret),
      label: r.label ?? null,
    }));
  }

  deletePairing(daemonId: string): void {
    this.metaDb.run("DELETE FROM pairings WHERE daemon_id = ?", [daemonId]);
  }

  listPairings(): PairingSummary[] {
    const rows = this.metaDb
      .prepare(
        "SELECT daemon_id, relay_url, created_at, label FROM pairings ORDER BY created_at ASC",
      )
      .all() as Array<{
      daemon_id: string;
      relay_url: string;
      created_at: number;
      label: string | null;
    }>;
    return rows.map((r) => ({
      daemonId: r.daemon_id,
      relayUrl: r.relay_url,
      createdAt: r.created_at,
      label: r.label ?? null,
    }));
  }

  /**
   * Test-only: clear metadata rows, close cached session dbs, and sweep the
   * per-session `.sqlite` files on disk. The meta db itself is kept open so
   * shared-fixture blocks can reuse it.
   */
  resetForTest(): void {
    for (const db of this.sessionDbs.values()) {
      db.close();
    }
    this.sessionDbs.clear();
    this.metaDb.run("DELETE FROM sessions");
    this.metaDb.run("DELETE FROM pairings");
    // Sweep per-session files so later tests cannot observe stale data via
    // getSessionDb(sid) reopening an on-disk leftover.
    const sessionsDir = join(this.storeDir, "sessions");
    try {
      rmSync(sessionsDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn(`resetForTest: failed to sweep ${sessionsDir} (${code})`);
      }
    }
    mkdirSync(sessionsDir, { recursive: true });
  }

  close(): void {
    for (const db of this.sessionDbs.values()) {
      db.close();
    }
    this.sessionDbs.clear();
    this.metaDb.close();
  }
}
