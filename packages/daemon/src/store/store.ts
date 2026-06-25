import { Database } from "bun:sqlite";
import {
  assertSafeSid,
  createLogger,
  decodeWireLabel,
  type Label,
  labelToNullable,
  type SessionState,
  type SID,
} from "@teleprompter/protocol";
import { mkdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { getStoreDir } from "./config";
import { parseStoredPairing, type StoredPairing } from "./pairing-row-guard";
import {
  PAIRINGS_DDL,
  PAIRINGS_MIGRATIONS,
  PRAGMAS,
  PUSH_TOKENS_DDL,
  SESSIONS_DDL,
} from "./schema";
import { SessionDb } from "./session-db";

const log = createLogger("Store");

export interface PairingSummary {
  daemonId: string;
  relayUrl: string;
  createdAt: number;
  /** Pairing label as a tagged union; `{ set: false }` = no label. */
  label: Label;
}

/**
 * Adapt a `Label` to the nullable string the SQLite `label TEXT` column
 * stores. `{ set: false }` → `null`. The column DDL is unchanged — the union
 * lives only in TypeScript; SQLite still sees `NULL` or a non-empty string.
 */
function labelToSql(label: Label): string | null {
  return labelToNullable(label);
}

/**
 * Adapt a value read back from the `label TEXT` column to a `Label`. Uses the
 * forgiving `decodeWireLabel` so historical rows (which may hold `""` from a
 * pre-union daemon) and `NULL` both normalize to `{ set: false }`.
 */
function labelFromSql(raw: string | null): Label {
  return decodeWireLabel(raw);
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
    this.metaDb.run(PUSH_TOKENS_DDL);
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
      if (m && existingCols.has(m[1] ?? "")) continue;
      try {
        this.metaDb.run(sql);
      } catch (err) {
        // Safety net: if a concurrent open raced us, swallow dup-column errors.
        const msg = (err as Error).message ?? "";
        if (!/duplicate column|already exists/i.test(msg)) throw err;
      }
    }

    // On restart, handleHello calls createSession again with an existing sid.
    // A plain INSERT OR REPLACE would delete+reinsert the row, resetting
    // last_seq to 0 and stamping a fresh created_at — which breaks the
    // frontend's cursor replay (its cursor now exceeds the store's last_seq,
    // so resume returns nothing) and loses the original creation time. Use an
    // upsert that, on conflict, refreshes only the mutable fields and leaves
    // last_seq and created_at intact.
    this.createStmt = this.metaDb.prepare(
      `INSERT INTO sessions
         (sid, state, worktree_path, cwd, created_at, updated_at, claude_version, last_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(sid) DO UPDATE SET
         state = excluded.state,
         worktree_path = excluded.worktree_path,
         cwd = excluded.cwd,
         updated_at = excluded.updated_at,
         claude_version = excluded.claude_version`,
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
    // Defense in depth: `sid` is path-joined into `sessions/<sid>.sqlite` below,
    // so reject path-traversal at the lowest layer too (the IPC dispatcher also
    // guards frontend-supplied sids, but Store is the actual path-join site —
    // guarding here covers any other caller). Every generated sid passes.
    assertSafeSid(sid);
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
    // Guard the pathological cap=0 case: without this the eviction loop would
    // immediately close the db we just inserted (it is its own oldest entry),
    // handing the caller a closed handle. The default cap is 32 and 0 is never
    // configured in production, but clamp defensively so the invariant holds
    // for any constructor input.
    if (this.maxOpenSessionDbs <= 0) return;
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
   *
   * DATA-LOSS GUARD: A non-positive or non-finite maxAgeMs must be a no-op.
   * Without this guard, maxAgeMs <= 0 sets cutoff >= Date.now(), so the SQL
   * predicate `updated_at < cutoff` matches EVERY stopped session and silently
   * wipes all session history. Callers (startAutoCleanup, tp session prune)
   * validate before reaching here, but defense-in-depth at the store layer is
   * essential since this method is public API.
   */
  pruneOldSessions(maxAgeMs: number): number {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
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
    label?: Label;
  }): void {
    // `reconnectSaved → addClient → savePairing` runs for every stored pairing
    // on every daemon startup. A plain INSERT OR REPLACE would delete+reinsert
    // the row, stamping a fresh `created_at` each restart — which shifts the
    // `loadPairings() ORDER BY created_at ASC` reconnect priority and loses the
    // original pairing time. Use an upsert that, on conflict, refreshes only the
    // mutable fields and leaves `created_at` intact (mirrors the sessions fix).
    this.metaDb
      .prepare(
        `INSERT INTO pairings
         (daemon_id, relay_url, relay_token, registration_proof, public_key, secret_key, pairing_secret, created_at, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(daemon_id) DO UPDATE SET
           relay_url = excluded.relay_url,
           relay_token = excluded.relay_token,
           registration_proof = excluded.registration_proof,
           public_key = excluded.public_key,
           secret_key = excluded.secret_key,
           pairing_secret = excluded.pairing_secret,
           label = excluded.label`,
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
        data.label ? labelToSql(data.label) : null,
      );
  }

  updatePairingLabel(daemonId: string, label: Label): void {
    this.metaDb.run("UPDATE pairings SET label = ? WHERE daemon_id = ?", [
      labelToSql(label),
      daemonId,
    ]);
  }

  loadPairings(): StoredPairing[] {
    // `SELECT *` rows are untrusted: the three key columns are BLOBs that flow
    // straight into libsodium (`crypto_kx_*` requires exactly 32 bytes), so a
    // truncated/NULL/corrupt row must not reach key construction. Each row is
    // narrowed through `parseStoredPairing`; a row that fails validation is
    // logged and dropped so one corrupt pairing can't block the others from
    // reconnecting at startup.
    const rows = this.metaDb
      .prepare("SELECT * FROM pairings ORDER BY created_at ASC")
      .all();

    const pairings: StoredPairing[] = [];
    for (const raw of rows) {
      const pairing = parseStoredPairing(raw);
      if (!pairing) {
        const daemonId = (raw as { daemon_id?: unknown }).daemon_id;
        log.warn(
          `dropped corrupt pairing row (daemon_id=${
            typeof daemonId === "string" ? daemonId : "?"
          })`,
        );
        continue;
      }
      pairings.push(pairing);
    }
    return pairings;
  }

  deletePairing(daemonId: string): void {
    // Both deletes must commit atomically. As two autocommit statements, a
    // crash/SIGKILL/power-loss in the window between them would delete the
    // push tokens but leave the pairing — on next start the pairing reconnects
    // but push delivery is permanently broken for it. Wrap in a transaction.
    this.metaDb.transaction(() => {
      this.deletePushTokensForDaemon(daemonId);
      this.metaDb.run("DELETE FROM pairings WHERE daemon_id = ?", [daemonId]);
    })();
  }

  // ── Push Token Persistence (Path X) ──

  /**
   * Persist a sealed push token for a frontend. Uses INSERT OR REPLACE so a
   * re-registration from the same frontend updates the blob in place.
   * The `sealed` field is an opaque relay blob ("tpps1.<v>.<b64>") — daemon
   * treats it as an opaque string and never inspects its contents.
   */
  savePushToken(data: {
    frontendId: string;
    daemonId: string;
    sealed: string;
    platform: "ios" | "android";
  }): void {
    this.metaDb
      .prepare(
        `INSERT OR REPLACE INTO push_tokens
         (frontend_id, daemon_id, sealed, platform, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        data.frontendId,
        data.daemonId,
        data.sealed,
        data.platform,
        Date.now(),
      );
  }

  /**
   * Load all persisted push tokens on daemon startup. Defensively validates
   * each row and drops corrupt rows (matching the pattern from loadPairings).
   */
  loadPushTokens(): Array<{
    frontendId: string;
    daemonId: string;
    sealed: string;
    platform: "ios" | "android";
  }> {
    const rows = this.metaDb
      .prepare("SELECT * FROM push_tokens")
      .all() as Array<{
      frontend_id: string;
      daemon_id: string;
      sealed: string;
      platform: string;
    }>;

    const result: Array<{
      frontendId: string;
      daemonId: string;
      sealed: string;
      platform: "ios" | "android";
    }> = [];

    for (const row of rows) {
      if (
        typeof row.frontend_id !== "string" ||
        !row.frontend_id ||
        typeof row.daemon_id !== "string" ||
        !row.daemon_id ||
        typeof row.sealed !== "string" ||
        !row.sealed ||
        (row.platform !== "ios" && row.platform !== "android")
      ) {
        log.warn(
          `dropped corrupt push_token row (frontend_id=${typeof row.frontend_id === "string" ? row.frontend_id : "?"})`,
        );
        continue;
      }
      result.push({
        frontendId: row.frontend_id,
        daemonId: row.daemon_id,
        sealed: row.sealed,
        platform: row.platform as "ios" | "android",
      });
    }
    return result;
  }

  /** Delete a single push token by frontendId. */
  deletePushToken(frontendId: string): void {
    this.metaDb.run("DELETE FROM push_tokens WHERE frontend_id = ?", [
      frontendId,
    ]);
  }

  /** Delete all push tokens associated with a daemonId (cascade on pairing delete). */
  deletePushTokensForDaemon(daemonId: string): void {
    this.metaDb.run("DELETE FROM push_tokens WHERE daemon_id = ?", [daemonId]);
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
      label: labelFromSql(r.label),
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
    this.metaDb.run("DELETE FROM push_tokens");
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
