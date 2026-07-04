import { Database } from "bun:sqlite";
import {
  assertSafeSid,
  createLogger,
  decodeWireLabel,
  deriveLegacyPairingId,
  type Label,
  labelToNullable,
  type SessionState,
  type SID,
} from "@teleprompter/protocol";
import { mkdirSync, readdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { getStoreDir } from "./config";
import { parseStoredPairing, type StoredPairing } from "./pairing-row-guard";
import {
  PAIRING_CONFIRMATIONS_DDL,
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
    this.metaDb.run(PAIRING_CONFIRMATIONS_DDL);
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

    // Delete session database file AND its WAL/SHM sidecars. Session DBs run in
    // WAL mode (schema.ts PRAGMAS), so SQLite maintains `${sid}.sqlite-wal` and
    // `${sid}.sqlite-shm` alongside the main file. `db.close()` only removes the
    // sidecars when it can take an exclusive lock and checkpoint cleanly — in
    // practice they frequently survive, and unlinking just the main file then
    // orphans them on disk, accumulating one -wal + one -shm per deleted/pruned
    // session forever. unlinkRetry treats ENOENT as success, so it is safe when
    // SQLite did already remove a sidecar.
    const dbPath = join(this.storeDir, "sessions", `${sid}.sqlite`);
    this.unlinkRetry(dbPath);
    this.unlinkRetry(`${dbPath}-wal`);
    this.unlinkRetry(`${dbPath}-shm`);
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
   * Self-heal orphaned WAL/SHM sidecar files left behind by older daemon
   * builds whose deleteSession unlinked only the main `${sid}.sqlite`. Such a
   * build leaks one `${sid}.sqlite-wal` + one `${sid}.sqlite-shm` per deleted
   * or pruned session forever; a long-lived dogfood store accumulated hundreds.
   *
   * A sidecar is an orphan iff its base `.sqlite` does not exist on disk AND it
   * is not backing a currently-open session (a live WAL must never be removed —
   * SQLite would lose un-checkpointed writes). We scan the sessions dir, group
   * by base name, and only unlink `-wal`/`-shm` whose base file is absent and
   * whose sid is not in `this.sessionDbs`.
   *
   * Returns the number of sidecar files removed. Best-effort: a readdir failure
   * (missing dir on a fresh store) is treated as zero orphans, and individual
   * unlink failures are swallowed by unlinkRetry (logged, not thrown), so this
   * is safe to call unguarded from the startup path.
   */
  sweepOrphanedSidecars(): number {
    const sessionsDir = join(this.storeDir, "sessions");
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir);
    } catch {
      // Fresh store with no sessions dir yet, or an unreadable dir — nothing
      // to sweep. Never let a readdir error abort daemon startup.
      return 0;
    }

    const present = new Set(entries);
    let removed = 0;
    for (const name of entries) {
      const isWal = name.endsWith(".sqlite-wal");
      const isShm = name.endsWith(".sqlite-shm");
      if (!isWal && !isShm) continue;

      // Strip the "-wal"/"-shm" suffix to recover the base "${sid}.sqlite".
      const base = name.slice(0, -4);
      // A live session's sidecar must be left alone — removing an open WAL
      // discards un-checkpointed writes. base = "${sid}.sqlite", so the sid is
      // base without the ".sqlite" extension.
      const sid = base.slice(0, -".sqlite".length);
      if (present.has(base) || this.sessionDbs.has(sid)) continue;

      this.unlinkRetry(join(sessionsDir, name));
      removed++;
    }
    return removed;
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
    pairingId: string;
    hostname: string;
  }): void {
    // `reconnectSaved → addClient → savePairing` runs for every stored pairing
    // on every daemon startup. A plain INSERT OR REPLACE would delete+reinsert
    // the row, stamping a fresh `created_at` each restart — which shifts the
    // `loadPairings() ORDER BY created_at ASC` reconnect priority and loses the
    // original pairing time. Use an upsert that, on conflict, refreshes only the
    // mutable fields and leaves `created_at` intact (mirrors the sessions fix).
    //
    // `pairing_id`/`hostname` are pairing identity, not mutable state: an
    // empty string means "unknown" (a legacy row whose async backfill hasn't
    // run yet) and is stored as NULL, and the upsert COALESCEs so a caller
    // that doesn't know the identity can never clobber a value already
    // persisted (e.g. a reconnect racing the migratePairingIds backfill).
    this.metaDb
      .prepare(
        `INSERT INTO pairings
         (daemon_id, relay_url, relay_token, registration_proof, public_key, secret_key, pairing_secret, created_at, label, pairing_id, hostname)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(daemon_id) DO UPDATE SET
           relay_url = excluded.relay_url,
           relay_token = excluded.relay_token,
           registration_proof = excluded.registration_proof,
           public_key = excluded.public_key,
           secret_key = excluded.secret_key,
           pairing_secret = excluded.pairing_secret,
           label = excluded.label,
           pairing_id = COALESCE(excluded.pairing_id, pairings.pairing_id),
           hostname = COALESCE(excluded.hostname, pairings.hostname)`,
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
        data.pairingId || null,
        data.hostname || null,
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
    // All deletes must commit atomically. As separate autocommit statements, a
    // crash/SIGKILL/power-loss in the window between them would delete the
    // push tokens but leave the pairing — on next start the pairing reconnects
    // but push delivery is permanently broken for it. Wrap in a transaction.
    this.metaDb.transaction(() => {
      this.deletePushTokensForDaemon(daemonId);
      this.metaDb.run("DELETE FROM pairing_confirmations WHERE daemon_id = ?", [
        daemonId,
      ]);
      this.metaDb.run("DELETE FROM pairings WHERE daemon_id = ?", [daemonId]);
    })();
  }

  // ── Pairing Confirmations (PCT) ──

  /**
   * Persist a per-frontend Pairing Confirmation Tag. One row per
   * (daemonId, frontendId); a reconnect from the same frontend recomputes the
   * same tag (same ECDH keys), so INSERT OR REPLACE is a harmless refresh.
   */
  savePairingConfirmation(data: {
    daemonId: string;
    frontendId: string;
    pct: Uint8Array;
    frontendPk: Uint8Array;
    confirmedAt: number;
  }): void {
    this.metaDb
      .prepare(
        `INSERT OR REPLACE INTO pairing_confirmations
         (daemon_id, frontend_id, pct, frontend_pk, confirmed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        data.daemonId,
        data.frontendId,
        data.pct,
        data.frontendPk,
        data.confirmedAt,
      );
  }

  getPairingConfirmation(
    daemonId: string,
    frontendId: string,
  ): {
    daemonId: string;
    frontendId: string;
    pct: Uint8Array;
    frontendPk: Uint8Array;
    confirmedAt: number;
  } | null {
    const row = this.metaDb
      .prepare(
        "SELECT * FROM pairing_confirmations WHERE daemon_id = ? AND frontend_id = ?",
      )
      .get(daemonId, frontendId) as {
      daemon_id: string;
      frontend_id: string;
      pct: Uint8Array;
      frontend_pk: Uint8Array;
      confirmed_at: number;
    } | null;
    if (!row) return null;
    return {
      daemonId: row.daemon_id,
      frontendId: row.frontend_id,
      pct: new Uint8Array(row.pct),
      frontendPk: new Uint8Array(row.frontend_pk),
      confirmedAt: row.confirmed_at,
    };
  }

  /** Confirmation count for a pairing (diagnostics: `tp pair list`). */
  countPairingConfirmations(daemonId: string): number {
    const row = this.metaDb
      .prepare(
        "SELECT COUNT(*) AS n FROM pairing_confirmations WHERE daemon_id = ?",
      )
      .get(daemonId) as { n: number };
    return row.n;
  }

  /**
   * Remove confirmation rows whose pairing no longer exists. A pending
   * pairing that completes kx but is never promoted (daemon crash in the
   * window) can leave a confirmation row with no matching pairings row —
   * deletePairing cascades only for promoted pairings. Swept once at startup
   * (same self-heal pattern as sweepOrphanedSidecars / push-token purge).
   */
  sweepOrphanedConfirmations(): number {
    return this.metaDb.run(
      "DELETE FROM pairing_confirmations WHERE daemon_id NOT IN (SELECT daemon_id FROM pairings)",
    ).changes;
  }

  /**
   * Backfill `pairing_id` for rows paired before the QR carried an explicit
   * pairingId, using the deterministic legacy derivation (BLAKE2b → UUIDv8 —
   * identical on the app side, so both ends of a legacy pairing converge on
   * the same id without any wire exchange). Async because the derivation
   * needs sodium init; the Store constructor is sync, so the daemon bootstrap
   * awaits this before reconnecting saved pairings.
   */
  async migratePairingIds(): Promise<number> {
    const rows = this.metaDb
      .prepare(
        "SELECT daemon_id FROM pairings WHERE pairing_id IS NULL OR pairing_id = ''",
      )
      .all() as { daemon_id: string }[];
    for (const { daemon_id } of rows) {
      const pairingId = await deriveLegacyPairingId(daemon_id);
      this.metaDb.run(
        "UPDATE pairings SET pairing_id = ? WHERE daemon_id = ?",
        [pairingId, daemon_id],
      );
    }
    if (rows.length > 0) {
      log.info(`backfilled legacy pairing_id for ${rows.length} pairing(s)`);
    }
    return rows.length;
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

    // Corrupt rows are not just skipped in memory — they are PURGED from the
    // table. A row that fails this guard (e.g. an empty daemon_id written by an
    // older buggy code path) is permanently unusable, so leaving it in place
    // means every subsequent daemon startup re-reads and re-warns about the
    // same dead rows forever (observed in the wild: 4 stale rows → 140+ repeated
    // "dropped corrupt push_token row" log lines). Collect their primary keys
    // and delete them after the read so the table self-heals on first load.
    const corruptFrontendIds: string[] = [];

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
        // Only a string frontend_id can be targeted by the DELETE; a row with a
        // non-string PK can't exist under the TEXT PRIMARY KEY schema, but guard
        // anyway so we never pass a non-string into the delete.
        if (typeof row.frontend_id === "string" && row.frontend_id) {
          corruptFrontendIds.push(row.frontend_id);
        }
        continue;
      }
      result.push({
        frontendId: row.frontend_id,
        daemonId: row.daemon_id,
        sealed: row.sealed,
        platform: row.platform as "ios" | "android",
      });
    }

    for (const fid of corruptFrontendIds) {
      this.metaDb.run("DELETE FROM push_tokens WHERE frontend_id = ?", [fid]);
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
    this.metaDb.run("DELETE FROM pairing_confirmations");
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
