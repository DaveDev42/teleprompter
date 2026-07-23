//! The core metadata store: sessions, pairings, pairing confirmations, and
//! push tokens, plus the LRU-of-32 `SessionDb` cache.
//!
//! Byte-exact port of `packages/daemon/src/store/store.ts` (757 LOC). Every
//! SQL statement here is copied verbatim from the TS source — see
//! `schema.rs` for the DDL/PRAGMA constants and the module doc comments below
//! for the upsert/migration semantics that must match exactly.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use tp_proto::assert_safe_sid;
use tp_proto::label::{decode_wire_label, label_to_nullable, Label};

use super::pairing_row_guard::{parse_stored_pairing, RawPairingRow, StoredPairing};
use super::schema::{
    PAIRINGS_DDL, PAIRINGS_MIGRATIONS, PAIRING_CONFIRMATIONS_DDL, PRAGMAS, PUSH_TOKENS_DDL,
    SESSIONS_DDL,
};
use super::session_db::SessionDb;

/// Soft cap on how many per-session SQLite handles stay open concurrently.
/// Mirrors `DEFAULT_MAX_OPEN_SESSION_DBS` (store.ts).
pub const DEFAULT_MAX_OPEN_SESSION_DBS: usize = 32;

/// Raw store-row shape returned by `get_session`/`list_sessions` — the
/// `SELECT * FROM sessions` columns, snake_case, unconverted. Wire-shape
/// conversion (`toSessionMeta`) is deferred to inc2 (session-meta.ts is a
/// wire-conversion helper, not part of the pure store layer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    pub sid: String,
    pub state: String,
    pub worktree_path: Option<String>,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub claude_version: Option<String>,
    pub last_seq: i64,
}

/// A `pairings` summary row (`daemon_id`, `relay_url`, `created_at`, `label`)
/// — mirrors `PairingSummary` (store.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingSummary {
    pub daemon_id: String,
    pub relay_url: String,
    pub created_at: i64,
    pub label: Label,
}

/// Input to [`Store::save_pairing`]. Mirrors the TS `savePairing(data)` param
/// object.
#[derive(Debug, Clone)]
pub struct SavePairingInput {
    pub daemon_id: String,
    pub relay_url: String,
    pub relay_token: String,
    pub registration_proof: String,
    pub public_key: Vec<u8>,
    pub secret_key: Vec<u8>,
    pub pairing_secret: Vec<u8>,
    pub label: Option<Label>,
    pub pairing_id: String,
    pub hostname: String,
}

/// A persisted Pairing Confirmation Tag row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingConfirmation {
    pub daemon_id: String,
    pub frontend_id: String,
    pub pct: Vec<u8>,
    pub frontend_pk: Vec<u8>,
    pub confirmed_at: i64,
}

/// Push token platform. Mirrors the TS `"ios" | "android"` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushPlatform {
    Ios,
    Android,
}

impl PushPlatform {
    /// The wire string for this platform. Public (increment 4): the
    /// relay-manager's `PushNotifierDeps` glue converts between
    /// `push_notifier`'s `&str` platform (mirroring the TS `"ios" |
    /// "android"` union at that layer) and this store-side typed enum.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            PushPlatform::Ios => "ios",
            PushPlatform::Android => "android",
        }
    }

    /// Parse a wire platform string. Public (increment 4) for the same
    /// reason as `as_str`.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ios" => Some(PushPlatform::Ios),
            "android" => Some(PushPlatform::Android),
            _ => None,
        }
    }
}

/// A persisted push token row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushToken {
    pub frontend_id: String,
    pub daemon_id: String,
    pub sealed: String,
    pub platform: PushPlatform,
}

/// Current wall-clock time in milliseconds since the Unix epoch. Mirrors
/// `Date.now()`.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The daemon's SQLite-backed metadata + per-session record store.
pub struct Store {
    meta_db: Connection,
    /// Insertion-ordered map doubles as an LRU: every access re-inserts the
    /// key (removed from `order` and pushed to the back), so `order.front()`
    /// is the least-recently-used sid.
    session_dbs: HashMap<String, SessionDb>,
    order: VecDeque<String>,
    max_open_session_dbs: usize,
    store_dir: PathBuf,
}

impl Store {
    /// Open (or create) the store at `store_dir` (defaults to
    /// [`super::config::get_store_dir`] when `None`), applying PRAGMAs, DDL,
    /// and probe-before-ALTER migrations exactly as the TS constructor does.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on any DB open/DDL failure.
    ///
    /// # Panics
    /// Panics if the `sessions` subdirectory cannot be created (mirrors the
    /// TS constructor, which lets `mkdirSync` throw uncaught).
    pub fn open(
        store_dir: Option<PathBuf>,
        max_open_session_dbs: Option<usize>,
    ) -> rusqlite::Result<Self> {
        let store_dir = store_dir.unwrap_or_else(super::config::get_store_dir);
        let max_open_session_dbs = max_open_session_dbs.unwrap_or(DEFAULT_MAX_OPEN_SESSION_DBS);

        fs::create_dir_all(store_dir.join("sessions"))
            .expect("failed to create the store's sessions dir");

        let meta_db = Connection::open(store_dir.join("sessions.sqlite"))?;
        for pragma in PRAGMAS {
            meta_db.execute_batch(pragma)?;
        }
        meta_db.execute_batch(SESSIONS_DDL)?;
        meta_db.execute_batch(PAIRINGS_DDL)?;
        meta_db.execute_batch(PUSH_TOKENS_DDL)?;
        meta_db.execute_batch(PAIRING_CONFIRMATIONS_DDL)?;

        // Probe the current schema and only run ALTER when columns are
        // missing. Fresh DBs already have every column from PAIRINGS_DDL;
        // this is strictly for upgrading pre-label databases.
        let existing_cols: std::collections::HashSet<String> = {
            let mut stmt = meta_db.prepare("PRAGMA table_info(pairings)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?; // column 1 = "name"
            rows.collect::<Result<_, _>>()?
        };
        for sql in PAIRINGS_MIGRATIONS {
            if let Some(col) = extract_add_column_name(sql) {
                if existing_cols.contains(col) {
                    continue;
                }
            }
            match meta_db.execute_batch(sql) {
                Ok(()) => {}
                Err(err) => {
                    let msg = err.to_string().to_lowercase();
                    if !(msg.contains("duplicate column") || msg.contains("already exists")) {
                        return Err(err);
                    }
                    // Safety net: a concurrent open raced us — swallow.
                }
            }
        }

        Ok(Self {
            meta_db,
            session_dbs: HashMap::new(),
            order: VecDeque::new(),
            max_open_session_dbs,
            store_dir,
        })
    }

    fn session_db_path(&self, sid: &str) -> PathBuf {
        self.store_dir
            .join("sessions")
            .join(format!("{sid}.sqlite"))
    }

    // ── Session Persistence ──

    /// Create (or, on conflict, refresh the mutable fields of) a session row,
    /// then open/track its `SessionDb`.
    ///
    /// The upsert intentionally does NOT touch `last_seq`/`created_at` on
    /// conflict: on restart, `handleHello` calls this again with an existing
    /// sid, and a plain replace would reset the frontend's cursor and lose
    /// the original creation time.
    ///
    /// # Errors
    /// Returns `Err(String)` if `sid` fails [`assert_safe_sid`], or the
    /// underlying `rusqlite::Error` (wrapped) on DB failure.
    pub fn create_session(
        &mut self,
        sid: &str,
        cwd: &str,
        worktree_path: Option<&str>,
        claude_version: Option<&str>,
    ) -> Result<(), StoreError> {
        // Defense in depth: `sid` is path-joined into `sessions/<sid>.sqlite`
        // below, so reject path-traversal at the lowest layer too.
        assert_safe_sid(sid).map_err(StoreError::InvalidSid)?;
        let now = now_ms();

        self.meta_db.execute(
            "INSERT INTO sessions
               (sid, state, worktree_path, cwd, created_at, updated_at, claude_version, last_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT(sid) DO UPDATE SET
               state = excluded.state,
               worktree_path = excluded.worktree_path,
               cwd = excluded.cwd,
               updated_at = excluded.updated_at,
               claude_version = excluded.claude_version",
            params![sid, "running", worktree_path, cwd, now, now, claude_version],
        )?;

        let db_path = self.session_db_path(sid);
        let session_db = SessionDb::open(db_path)?;
        self.track_session_db(sid, session_db);
        Ok(())
    }

    /// Get (opening + tracking if necessary) the `SessionDb` for `sid`.
    /// Touches the LRU on hit. Returns `None` if the sid is not cached and
    /// the on-disk `.sqlite` cannot be opened.
    ///
    /// Deliberately does not return a `&SessionDb` — Rust borrow rules make a
    /// "touch LRU + return reference" API awkward; callers needing the
    /// `SessionDb` should use [`Store::with_session_db`] or the record
    /// accessor methods below, which encapsulate the touch-then-use pattern.
    pub fn ensure_session_db(&mut self, sid: &str) -> bool {
        if self.session_dbs.contains_key(sid) {
            self.touch(sid);
            return true;
        }
        let db_path = self.session_db_path(sid);
        match SessionDb::open(db_path) {
            Ok(db) => {
                self.track_session_db(sid, db);
                true
            }
            Err(_) => false,
        }
    }

    /// Borrow the `SessionDb` for `sid`, opening/tracking it first if needed
    /// (mirrors `getSessionDb`). `None` if it cannot be opened.
    pub fn get_session_db(&mut self, sid: &str) -> Option<&SessionDb> {
        if self.ensure_session_db(sid) {
            self.session_dbs.get(sid)
        } else {
            None
        }
    }

    fn touch(&mut self, sid: &str) {
        if let Some(pos) = self.order.iter().position(|s| s == sid) {
            self.order.remove(pos);
        }
        self.order.push_back(sid.to_string());
    }

    fn track_session_db(&mut self, sid: &str, db: SessionDb) {
        self.session_dbs.insert(sid.to_string(), db);
        // Re-insert at the tail (this is a fresh open — touch semantics).
        if let Some(pos) = self.order.iter().position(|s| s == sid) {
            self.order.remove(pos);
        }
        self.order.push_back(sid.to_string());

        // Guard the pathological cap<=0 case: without this the eviction loop
        // would immediately close the db we just inserted (it is its own
        // oldest entry), handing the caller a closed handle.
        if self.max_open_session_dbs == 0 {
            return;
        }
        while self.session_dbs.len() > self.max_open_session_dbs {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(db) = self.session_dbs.remove(&oldest) {
                db.close();
            }
        }
    }

    /// Test-only: register `sid` as cache-tracked using an in-memory
    /// `SessionDb` (no on-disk file), so tests can exercise the
    /// `session_dbs.contains_key` branch of cache-aware logic (e.g.
    /// `sweep_orphaned_sidecars`'s live-WAL guard) without opening a real
    /// `<sid>.sqlite` file whose WAL/SHM sidecars must not be tampered with
    /// out-of-band.
    #[cfg(test)]
    fn track_session_db_for_test(&mut self, sid: &str) {
        let db = SessionDb::open_in_memory_for_test().expect("in-memory SessionDb open");
        self.track_session_db(sid, db);
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn update_session_state(&self, sid: &str, state: &str) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "UPDATE sessions SET state = ?, updated_at = ? WHERE sid = ?",
            params![state, now_ms(), sid],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn update_last_seq(&self, sid: &str, seq: i64) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "UPDATE sessions SET last_seq = ?, updated_at = ? WHERE sid = ?",
            params![seq, now_ms(), sid],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn get_session(&self, sid: &str) -> rusqlite::Result<Option<SessionMeta>> {
        self.meta_db
            .query_row(
                "SELECT * FROM sessions WHERE sid = ?",
                params![sid],
                row_to_session_meta,
            )
            .optional()
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionMeta>> {
        let mut stmt = self
            .meta_db
            .prepare("SELECT * FROM sessions ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], row_to_session_meta)?;
        rows.collect()
    }

    /// Delete a session and its record database (main file + WAL/SHM
    /// sidecars).
    ///
    /// KNOWN NON-ATOMIC (accepted, decision-gated): the metadata row is
    /// DELETEd before the on-disk `.sqlite`/`-wal`/`-shm` unlinks. A crash
    /// between the two steps leaks the base `.sqlite` file permanently —
    /// `sweep_orphaned_sidecars` reclaims only orphaned WAL/SHM sidecars,
    /// never a base file whose metadata row is gone. Reordering the steps
    /// (or adding a row-less-base recovery sweep) changes crash semantics;
    /// if this leak is observed in practice, surface it for a design
    /// decision rather than silently reordering.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on the metadata DELETE.
    /// Sidecar unlink failures are retried/logged internally (never
    /// propagated) except for unexpected errno values, which surface as
    /// `io::Error` wrapped in `StoreError`.
    pub fn delete_session(&mut self, sid: &str) -> Result<(), StoreError> {
        if let Some(db) = self.session_dbs.remove(sid) {
            if let Some(pos) = self.order.iter().position(|s| s == sid) {
                self.order.remove(pos);
            }
            db.close();
        }

        self.meta_db
            .execute("DELETE FROM sessions WHERE sid = ?", params![sid])?;

        // Session DBs run in WAL mode, so SQLite maintains `<sid>.sqlite-wal`
        // and `<sid>.sqlite-shm` alongside the main file. Closing the
        // connection only removes the sidecars when it can take an exclusive
        // lock and checkpoint cleanly — in practice they frequently survive,
        // so unlink all three explicitly (orphan-prevention).
        let db_path = self.session_db_path(sid);
        let wal_path = append_suffix(&db_path, "-wal");
        let shm_path = append_suffix(&db_path, "-shm");
        unlink_retry(&db_path)?;
        unlink_retry(&wal_path)?;
        unlink_retry(&shm_path)?;
        Ok(())
    }

    /// Self-heal orphaned WAL/SHM sidecar files whose base `.sqlite` no
    /// longer exists AND which are not backing a currently-open session (a
    /// live WAL must never be removed). Returns the number of sidecars
    /// removed. Best-effort: a readdir failure is treated as zero orphans.
    ///
    /// # Errors
    /// Returns `Err` only if an unlink fails with an unexpected errno (not
    /// `ENOENT`/`EBUSY`/`EPERM`, all of which are handled internally by
    /// `unlink_retry`).
    pub fn sweep_orphaned_sidecars(&self) -> Result<usize, StoreError> {
        let sessions_dir = self.store_dir.join("sessions");
        let entries = match fs::read_dir(&sessions_dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            Err(_) => return Ok(0), // fresh store, or unreadable dir — nothing to sweep
        };
        let present: std::collections::HashSet<&str> = entries.iter().map(String::as_str).collect();

        let mut removed = 0usize;
        for name in &entries {
            let is_wal = name.ends_with(".sqlite-wal");
            let is_shm = name.ends_with(".sqlite-shm");
            if !is_wal && !is_shm {
                continue;
            }
            // Strip the "-wal"/"-shm" suffix (4 bytes) to recover the base
            // "<sid>.sqlite".
            let base = &name[..name.len() - 4];
            let sid = &base[..base.len() - ".sqlite".len()];
            if present.contains(base) || self.session_dbs.contains_key(sid) {
                continue;
            }
            unlink_retry(&sessions_dir.join(name))?;
            removed += 1;
        }
        Ok(removed)
    }

    /// Delete all stopped/error sessions older than `max_age_ms`.
    ///
    /// DATA-LOSS GUARD: a non-positive `max_age_ms` is a no-op — without this
    /// guard, `cutoff >= now()` would match every stopped session.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error`/`StoreError` from the SELECT
    /// or any `delete_session` call.
    pub fn prune_old_sessions(&mut self, max_age_ms: i64) -> Result<usize, StoreError> {
        if max_age_ms <= 0 {
            return Ok(0);
        }
        let cutoff = now_ms() - max_age_ms;
        let sids: Vec<String> = {
            let mut stmt = self
                .meta_db
                .prepare("SELECT sid FROM sessions WHERE state != 'running' AND updated_at < ?")?;
            let rows = stmt.query_map(params![cutoff], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };

        for sid in &sids {
            self.delete_session(sid)?;
        }
        Ok(sids.len())
    }

    // ── Pairing Persistence ──

    /// Upsert a pairing row. On conflict, refreshes only the mutable fields
    /// and leaves `created_at` intact (mirrors the sessions upsert fix).
    /// `pairing_id`/`hostname` are stored as `NULL` when empty and the
    /// upsert COALESCEs so a caller that doesn't know the identity can never
    /// clobber a value already persisted.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn save_pairing(&self, data: &SavePairingInput) -> rusqlite::Result<()> {
        let label_sql = data.label.as_ref().and_then(label_to_nullable);
        let pairing_id = if data.pairing_id.is_empty() {
            None
        } else {
            Some(data.pairing_id.as_str())
        };
        let hostname = if data.hostname.is_empty() {
            None
        } else {
            Some(data.hostname.as_str())
        };

        self.meta_db.execute(
            "INSERT INTO pairings
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
               hostname = COALESCE(excluded.hostname, pairings.hostname)",
            params![
                data.daemon_id,
                data.relay_url,
                data.relay_token,
                data.registration_proof,
                data.public_key,
                data.secret_key,
                data.pairing_secret,
                now_ms(),
                label_sql,
                pairing_id,
                hostname,
            ],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn update_pairing_label(&self, daemon_id: &str, label: &Label) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "UPDATE pairings SET label = ? WHERE daemon_id = ?",
            params![label_to_nullable(label), daemon_id],
        )?;
        Ok(())
    }

    /// Load and validate all pairing rows. Corrupt rows are dropped (the
    /// caller should log the drop; this layer just filters).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn load_pairings(&self) -> rusqlite::Result<Vec<StoredPairing>> {
        let mut stmt = self
            .meta_db
            .prepare("SELECT * FROM pairings ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], row_to_raw_pairing)?;
        let mut pairings = Vec::new();
        for row in rows {
            let raw = row?;
            if let Some(parsed) = parse_stored_pairing(&raw) {
                pairings.push(parsed);
            }
            // Corrupt rows are silently dropped here; callers wanting the
            // `daemon_id` for a warning log can re-query or use a variant
            // that also returns the raw rows if that becomes necessary.
        }
        Ok(pairings)
    }

    /// Delete a pairing and its associated push tokens + pairing
    /// confirmations, atomically (all-or-nothing).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` if the transaction fails.
    pub fn delete_pairing(&mut self, daemon_id: &str) -> rusqlite::Result<()> {
        let tx = self.meta_db.transaction()?;
        tx.execute(
            "DELETE FROM push_tokens WHERE daemon_id = ?",
            params![daemon_id],
        )?;
        tx.execute(
            "DELETE FROM pairing_confirmations WHERE daemon_id = ?",
            params![daemon_id],
        )?;
        tx.execute(
            "DELETE FROM pairings WHERE daemon_id = ?",
            params![daemon_id],
        )?;
        tx.commit()
    }

    // ── Pairing Confirmations (PCT) ──

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn save_pairing_confirmation(&self, data: &PairingConfirmation) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "INSERT OR REPLACE INTO pairing_confirmations
             (daemon_id, frontend_id, pct, frontend_pk, confirmed_at)
             VALUES (?, ?, ?, ?, ?)",
            params![
                data.daemon_id,
                data.frontend_id,
                data.pct,
                data.frontend_pk,
                data.confirmed_at
            ],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn get_pairing_confirmation(
        &self,
        daemon_id: &str,
        frontend_id: &str,
    ) -> rusqlite::Result<Option<PairingConfirmation>> {
        self.meta_db
            .query_row(
                "SELECT * FROM pairing_confirmations WHERE daemon_id = ? AND frontend_id = ?",
                params![daemon_id, frontend_id],
                |row| {
                    Ok(PairingConfirmation {
                        daemon_id: row.get("daemon_id")?,
                        frontend_id: row.get("frontend_id")?,
                        pct: row.get("pct")?,
                        frontend_pk: row.get("frontend_pk")?,
                        confirmed_at: row.get("confirmed_at")?,
                    })
                },
            )
            .optional()
    }

    /// Confirmation count for a pairing (diagnostics: `tp pair list`).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn count_pairing_confirmations(&self, daemon_id: &str) -> rusqlite::Result<i64> {
        self.meta_db.query_row(
            "SELECT COUNT(*) AS n FROM pairing_confirmations WHERE daemon_id = ?",
            params![daemon_id],
            |row| row.get(0),
        )
    }

    /// Remove confirmation rows whose pairing no longer exists. Returns the
    /// number of rows removed.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn sweep_orphaned_confirmations(&self) -> rusqlite::Result<usize> {
        let n = self.meta_db.execute(
            "DELETE FROM pairing_confirmations WHERE daemon_id NOT IN (SELECT daemon_id FROM pairings)",
            [],
        )?;
        Ok(n)
    }

    /// Backfill `pairing_id` for rows paired before the QR carried an
    /// explicit pairingId, using the deterministic legacy derivation
    /// (`tp_core::derive_legacy_pairing_id`). Synchronous in Rust (the TS
    /// version is async only for sodium init).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query/update failure.
    pub fn migrate_pairing_ids(&self) -> rusqlite::Result<usize> {
        let daemon_ids: Vec<String> = {
            let mut stmt = self.meta_db.prepare(
                "SELECT daemon_id FROM pairings WHERE pairing_id IS NULL OR pairing_id = ''",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for daemon_id in &daemon_ids {
            let pairing_id = tp_core::derive_legacy_pairing_id(daemon_id.clone());
            self.meta_db.execute(
                "UPDATE pairings SET pairing_id = ? WHERE daemon_id = ?",
                params![pairing_id, daemon_id],
            )?;
        }
        Ok(daemon_ids.len())
    }

    // ── Push Token Persistence (Path X) ──

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn save_push_token(
        &self,
        frontend_id: &str,
        daemon_id: &str,
        sealed: &str,
        platform: PushPlatform,
    ) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "INSERT OR REPLACE INTO push_tokens
             (frontend_id, daemon_id, sealed, platform, updated_at)
             VALUES (?, ?, ?, ?, ?)",
            params![frontend_id, daemon_id, sealed, platform.as_str(), now_ms()],
        )?;
        Ok(())
    }

    /// Load all persisted push tokens, dropping AND purging corrupt rows
    /// (self-heal — a row that fails validation once will fail forever, so
    /// leaving it in place means every subsequent load re-reads and
    /// re-warns about the same dead row).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query/delete failure.
    pub fn load_push_tokens(&self) -> rusqlite::Result<Vec<PushToken>> {
        struct RawRow {
            frontend_id: Option<String>,
            daemon_id: Option<String>,
            sealed: Option<String>,
            platform: Option<String>,
        }

        let rows: Vec<RawRow> = {
            let mut stmt = self.meta_db.prepare("SELECT * FROM push_tokens")?;
            let mapped = stmt.query_map([], |row| {
                Ok(RawRow {
                    frontend_id: row.get("frontend_id")?,
                    daemon_id: row.get("daemon_id")?,
                    sealed: row.get("sealed")?,
                    platform: row.get("platform")?,
                })
            })?;
            mapped.collect::<Result<_, _>>()?
        };

        let mut result = Vec::new();
        let mut corrupt_frontend_ids: Vec<String> = Vec::new();

        for row in rows {
            let frontend_id_for_purge = row.frontend_id.clone();
            let valid = (|| -> Option<PushToken> {
                let frontend_id = row.frontend_id.filter(|s| !s.is_empty())?;
                let daemon_id = row.daemon_id.filter(|s| !s.is_empty())?;
                let sealed = row.sealed.filter(|s| !s.is_empty())?;
                let platform = row.platform.as_deref().and_then(PushPlatform::parse)?;
                Some(PushToken {
                    frontend_id,
                    daemon_id,
                    sealed,
                    platform,
                })
            })();

            match valid {
                Some(token) => result.push(token),
                None => {
                    if let Some(fid) = frontend_id_for_purge {
                        if !fid.is_empty() {
                            corrupt_frontend_ids.push(fid);
                        }
                    }
                }
            }
        }

        for fid in &corrupt_frontend_ids {
            self.meta_db.execute(
                "DELETE FROM push_tokens WHERE frontend_id = ?",
                params![fid],
            )?;
        }

        Ok(result)
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn delete_push_token(&self, frontend_id: &str) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "DELETE FROM push_tokens WHERE frontend_id = ?",
            params![frontend_id],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn delete_push_tokens_for_daemon(&self, daemon_id: &str) -> rusqlite::Result<()> {
        self.meta_db.execute(
            "DELETE FROM push_tokens WHERE daemon_id = ?",
            params![daemon_id],
        )?;
        Ok(())
    }

    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn list_pairings(&self) -> rusqlite::Result<Vec<PairingSummary>> {
        let mut stmt = self.meta_db.prepare(
            "SELECT daemon_id, relay_url, created_at, label FROM pairings ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let label_raw: Option<String> = row.get("label")?;
            let label_value = match label_raw {
                Some(s) => serde_json::Value::String(s),
                None => serde_json::Value::Null,
            };
            Ok(PairingSummary {
                daemon_id: row.get("daemon_id")?,
                relay_url: row.get("relay_url")?,
                created_at: row.get("created_at")?,
                label: decode_wire_label(&label_value),
            })
        })?;
        rows.collect()
    }

    /// Test-only: clear metadata rows, close cached session dbs, and sweep
    /// the per-session `.sqlite` files on disk. The meta db itself is kept
    /// open so shared-fixture test blocks can reuse it.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on any DELETE failure.
    pub fn reset_for_test(&mut self) -> rusqlite::Result<()> {
        for (_, db) in self.session_dbs.drain() {
            db.close();
        }
        self.order.clear();
        self.meta_db.execute("DELETE FROM sessions", [])?;
        self.meta_db.execute("DELETE FROM pairings", [])?;
        self.meta_db.execute("DELETE FROM push_tokens", [])?;
        self.meta_db
            .execute("DELETE FROM pairing_confirmations", [])?;

        let sessions_dir = self.store_dir.join("sessions");
        let _ = fs::remove_dir_all(&sessions_dir); // best-effort, mirrors force:true
        fs::create_dir_all(&sessions_dir).expect("failed to recreate sessions dir");
        Ok(())
    }

    /// Close all cached session dbs and the meta db.
    pub fn close(mut self) {
        for (_, db) in self.session_dbs.drain() {
            db.close();
        }
        // self.meta_db drops here, closing the connection.
        drop(self.meta_db);
    }
}

/// Errors surfaced by [`Store`] methods that can fail for reasons other than
/// a raw `rusqlite::Error` (invalid sid, unexpected sidecar-unlink errno).
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    InvalidSid(String),
    Io(std::io::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "{e}"),
            StoreError::InvalidSid(e) => write!(f, "{e}"),
            StoreError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Retry unlink on transient `EBUSY`/`EPERM` (rare on POSIX after a db
/// close). Budget: 25 + 50 + 100 + 200 + 400 + 800 = 1575 ms across 6
/// attempts. `ENOENT` is treated as success. Any other errno re-raises.
fn unlink_retry(path: &Path) -> Result<(), StoreError> {
    const MAX_ATTEMPTS: u32 = 6;
    let mut last_kind: Option<std::io::ErrorKind> = None;

    for attempt in 0..MAX_ATTEMPTS {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(());
                }
                let raw = err.raw_os_error();
                let is_busy_or_perm = matches!(raw, Some(libc_ebusy) if libc_ebusy == EBUSY)
                    || err.kind() == std::io::ErrorKind::PermissionDenied;
                last_kind = Some(err.kind());
                if is_busy_or_perm {
                    if attempt == MAX_ATTEMPTS - 1 {
                        break;
                    }
                    thread::sleep(Duration::from_millis(25 * 2u64.pow(attempt)));
                    continue;
                }
                return Err(StoreError::Io(err));
            }
        }
    }
    // Mirrors the TS `log.warn` — best-effort logging is the caller's
    // responsibility in this crate (no logger dependency here); we simply
    // stop retrying and return Ok, matching the TS behavior of NOT throwing
    // after exhausting retries.
    let _ = last_kind;
    Ok(())
}

#[cfg(unix)]
const EBUSY: i32 = 16; // POSIX errno EBUSY, stable across Linux/macOS.
#[cfg(not(unix))]
const EBUSY: i32 = -1;

fn row_to_session_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionMeta> {
    Ok(SessionMeta {
        sid: row.get("sid")?,
        state: row.get("state")?,
        worktree_path: row.get("worktree_path")?,
        cwd: row.get("cwd")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        claude_version: row.get("claude_version")?,
        last_seq: row.get("last_seq")?,
    })
}

fn row_to_raw_pairing(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawPairingRow> {
    Ok(RawPairingRow {
        daemon_id: row.get("daemon_id")?,
        relay_url: row.get("relay_url")?,
        relay_token: row.get("relay_token")?,
        registration_proof: row.get("registration_proof")?,
        created_at: row.get("created_at")?,
        public_key: row.get("public_key")?,
        secret_key: row.get("secret_key")?,
        pairing_secret: row.get("pairing_secret")?,
        label: row.get("label")?,
        pairing_id: row.get("pairing_id")?,
        hostname: row.get("hostname")?,
    })
}

/// Extract the column name from an `ALTER TABLE pairings ADD COLUMN <name>
/// ...` statement (mirrors the TS regex `/ADD COLUMN\s+(\w+)/i`).
fn extract_add_column_name(sql: &str) -> Option<&str> {
    let lower = sql.to_lowercase();
    let idx = lower.find("add column")?;
    let after = sql[idx + "add column".len()..].trim_start();
    let end = after
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(after.len());
    if end == 0 {
        None
    } else {
        Some(&after[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(Some(dir.path().to_path_buf()), None).unwrap();
        (dir, store)
    }

    #[test]
    fn create_session_then_get() {
        let (_dir, mut store) = open_test_store();
        store
            .create_session("sess-1", "/tmp/work", None, None)
            .unwrap();
        let meta = store
            .get_session("sess-1")
            .unwrap()
            .expect("session exists");
        assert_eq!(meta.sid, "sess-1");
        assert_eq!(meta.state, "running");
        assert_eq!(meta.last_seq, 0);
        assert_eq!(meta.cwd, "/tmp/work");
    }

    #[test]
    fn create_session_rejects_unsafe_sid() {
        let (_dir, mut store) = open_test_store();
        let err = store
            .create_session("../evil", "/tmp", None, None)
            .unwrap_err();
        assert!(matches!(err, StoreError::InvalidSid(_)));
    }

    #[test]
    fn create_session_upsert_preserves_last_seq_and_created_at() {
        let (_dir, mut store) = open_test_store();
        store
            .create_session("sess-1", "/tmp/a", None, None)
            .unwrap();
        let db = store.get_session_db("sess-1").unwrap();
        db.append("io", 1, b"x", None, None).unwrap();
        store.update_last_seq("sess-1", 42).unwrap();

        let first = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(first.last_seq, 42);
        let created_at_1 = first.created_at;

        // Re-create with the same sid (simulates restart / handleHello).
        std::thread::sleep(std::time::Duration::from_millis(2));
        store
            .create_session("sess-1", "/tmp/b", Some("wt"), Some("1.2.3"))
            .unwrap();

        let second = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(
            second.last_seq, 42,
            "last_seq must survive re-create upsert"
        );
        assert_eq!(
            second.created_at, created_at_1,
            "created_at must survive re-create upsert"
        );
        assert_eq!(second.cwd, "/tmp/b");
        assert_eq!(second.worktree_path.as_deref(), Some("wt"));
        assert_eq!(second.claude_version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn list_sessions_orders_by_created_at_desc() {
        let (_dir, mut store) = open_test_store();
        store.create_session("a", "/tmp", None, None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.create_session("b", "/tmp", None, None).unwrap();
        let list = store.list_sessions().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sid, "b");
        assert_eq!(list[1].sid, "a");
    }

    #[test]
    fn delete_session_removes_row_and_files() {
        let (_dir, mut store) = open_test_store();
        store
            .create_session("sess-del", "/tmp", None, None)
            .unwrap();
        let path = store.session_db_path("sess-del");
        assert!(path.exists());

        store.delete_session("sess-del").unwrap();
        assert!(store.get_session("sess-del").unwrap().is_none());
        assert!(!path.exists());
    }

    #[test]
    fn lru_eviction_order_and_cap() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(Some(dir.path().to_path_buf()), Some(2)).unwrap();

        store.create_session("s1", "/tmp", None, None).unwrap();
        store.create_session("s2", "/tmp", None, None).unwrap();
        assert_eq!(store.session_dbs.len(), 2);

        // Touch s1 so s2 becomes the oldest.
        assert!(store.ensure_session_db("s1"));
        store.create_session("s3", "/tmp", None, None).unwrap();

        // Cap=2: s2 (least-recently-used) must have been evicted; s1 and s3 remain.
        assert_eq!(store.session_dbs.len(), 2);
        assert!(store.session_dbs.contains_key("s1"));
        assert!(store.session_dbs.contains_key("s3"));
        assert!(!store.session_dbs.contains_key("s2"));
    }

    #[test]
    fn lru_cap_zero_never_evicts_just_inserted_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(Some(dir.path().to_path_buf()), Some(0)).unwrap();
        store.create_session("only", "/tmp", None, None).unwrap();
        assert!(store.session_dbs.contains_key("only"));
        // Get should still work (handle wasn't force-closed).
        assert!(store.get_session_db("only").is_some());
    }

    #[test]
    fn sweep_orphaned_sidecars_spares_live_and_base_present() {
        let (_dir, mut store) = open_test_store();
        store.create_session("live", "/tmp", None, None).unwrap();

        let sessions_dir = store.store_dir.join("sessions");
        // Orphan: no base file, not in cache.
        fs::write(sessions_dir.join("orphan-sid.sqlite-wal"), b"x").unwrap();
        fs::write(sessions_dir.join("orphan-sid.sqlite-shm"), b"x").unwrap();
        // Base-present: has a .sqlite file, should be spared.
        fs::write(sessions_dir.join("has-base.sqlite"), b"x").unwrap();
        fs::write(sessions_dir.join("has-base.sqlite-wal"), b"x").unwrap();
        // Live: sid is in the cache (no base .sqlite file under this exact
        // name check — a fabricated sidecar for a cached-but-otherwise-
        // fileless sid), should be spared by the `session_dbs.contains_key`
        // branch. Deliberately NOT touching `live.sqlite-*` — those are
        // real, currently-mmap'd WAL/SHM files owned by the open SessionDb
        // connection created above; writing garbage into them out-of-band
        // corrupts SQLite's shared-memory index and SIGBUSes on next access
        // (verified empirically). A second cache key with a synthetic
        // sidecar exercises the same code path without that hazard.
        store.track_session_db_for_test("live-no-file");
        fs::write(sessions_dir.join("live-no-file.sqlite-shm"), b"x").unwrap();

        let removed = store.sweep_orphaned_sidecars().unwrap();
        assert_eq!(
            removed, 2,
            "only the true orphan's wal+shm should be removed"
        );
        assert!(!sessions_dir.join("orphan-sid.sqlite-wal").exists());
        assert!(!sessions_dir.join("orphan-sid.sqlite-shm").exists());
        assert!(sessions_dir.join("has-base.sqlite-wal").exists());
        assert!(sessions_dir.join("live-no-file.sqlite-shm").exists());
    }

    #[test]
    fn prune_old_sessions_guards_non_positive_max_age() {
        let (_dir, mut store) = open_test_store();
        store.create_session("s1", "/tmp", None, None).unwrap();
        store.update_session_state("s1", "stopped").unwrap();

        assert_eq!(store.prune_old_sessions(0).unwrap(), 0);
        assert_eq!(store.prune_old_sessions(-100).unwrap(), 0);
        assert!(
            store.get_session("s1").unwrap().is_some(),
            "session must survive a no-op prune"
        );
    }

    #[test]
    fn prune_old_sessions_deletes_stale_stopped_sessions() {
        let (_dir, mut store) = open_test_store();
        store.create_session("s1", "/tmp", None, None).unwrap();
        store.update_session_state("s1", "stopped").unwrap();
        // Backdate updated_at far into the past directly.
        store
            .meta_db
            .execute(
                "UPDATE sessions SET updated_at = ? WHERE sid = ?",
                params![now_ms() - 100_000, "s1"],
            )
            .unwrap();

        let pruned = store.prune_old_sessions(1000).unwrap();
        assert_eq!(pruned, 1);
        assert!(store.get_session("s1").unwrap().is_none());
    }

    #[test]
    fn prune_old_sessions_never_touches_running() {
        let (_dir, mut store) = open_test_store();
        store.create_session("s1", "/tmp", None, None).unwrap(); // state = running
        store
            .meta_db
            .execute(
                "UPDATE sessions SET updated_at = ? WHERE sid = ?",
                params![now_ms() - 100_000, "s1"],
            )
            .unwrap();
        let pruned = store.prune_old_sessions(1000).unwrap();
        assert_eq!(pruned, 0);
        assert!(store.get_session("s1").unwrap().is_some());
    }

    fn sample_pairing(daemon_id: &str) -> SavePairingInput {
        SavePairingInput {
            daemon_id: daemon_id.to_string(),
            relay_url: "wss://relay.example".to_string(),
            relay_token: "tok".to_string(),
            registration_proof: "proof".to_string(),
            public_key: vec![1u8; 32],
            secret_key: vec![2u8; 32],
            pairing_secret: vec![3u8; 32],
            label: None,
            pairing_id: String::new(),
            hostname: String::new(),
        }
    }

    #[test]
    fn save_pairing_upsert_preserves_created_at_and_coalesces_identity() {
        let (_dir, store) = open_test_store();
        let mut input = sample_pairing("d1");
        input.pairing_id = "pid-1".to_string();
        input.hostname = "host-1".to_string();
        store.save_pairing(&input).unwrap();

        let loaded = store.load_pairings().unwrap();
        assert_eq!(loaded.len(), 1);
        let created_at_1 = {
            let row: i64 = store
                .meta_db
                .query_row(
                    "SELECT created_at FROM pairings WHERE daemon_id = 'd1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            row
        };

        std::thread::sleep(std::time::Duration::from_millis(2));
        // Second save with empty pairing_id/hostname must NOT clobber the
        // already-persisted identity (COALESCE), and created_at must be
        // unchanged (upsert, not replace).
        let mut second = sample_pairing("d1");
        second.relay_token = "tok2".to_string();
        store.save_pairing(&second).unwrap();

        let created_at_2: i64 = store
            .meta_db
            .query_row(
                "SELECT created_at FROM pairings WHERE daemon_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(created_at_1, created_at_2, "created_at must survive upsert");

        let reloaded = store.load_pairings().unwrap();
        assert_eq!(
            reloaded[0].pairing_id, "pid-1",
            "COALESCE must preserve existing pairing_id"
        );
        assert_eq!(
            reloaded[0].hostname, "host-1",
            "COALESCE must preserve existing hostname"
        );
        assert_eq!(reloaded[0].relay_token, "tok2");
    }

    #[test]
    fn delete_pairing_removes_confirmations_and_tokens_atomically() {
        let (_dir, mut store) = open_test_store();
        store.save_pairing(&sample_pairing("d1")).unwrap();
        store
            .save_pairing_confirmation(&PairingConfirmation {
                daemon_id: "d1".to_string(),
                frontend_id: "f1".to_string(),
                pct: vec![9u8; 16],
                frontend_pk: vec![8u8; 32],
                confirmed_at: now_ms(),
            })
            .unwrap();
        store
            .save_push_token("f1", "d1", "sealed-blob", PushPlatform::Ios)
            .unwrap();

        store.delete_pairing("d1").unwrap();

        assert!(store.load_pairings().unwrap().is_empty());
        assert_eq!(store.count_pairing_confirmations("d1").unwrap(), 0);
        assert!(store.load_push_tokens().unwrap().is_empty());
    }

    #[test]
    fn load_push_tokens_purges_corrupt_rows() {
        let (_dir, store) = open_test_store();
        store
            .save_push_token("f-valid", "d1", "sealed", PushPlatform::Android)
            .unwrap();
        // Insert a corrupt row directly (empty daemon_id).
        store
            .meta_db
            .execute(
                "INSERT INTO push_tokens (frontend_id, daemon_id, sealed, platform, updated_at) VALUES (?, ?, ?, ?, ?)",
                params!["f-corrupt", "", "sealed", "ios", now_ms()],
            )
            .unwrap();

        let loaded = store.load_push_tokens().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].frontend_id, "f-valid");

        // The corrupt row must have been purged from the table.
        let count: i64 = store
            .meta_db
            .query_row(
                "SELECT COUNT(*) FROM push_tokens WHERE frontend_id = 'f-corrupt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        // A second load must not re-encounter (and re-purge) the same row —
        // it's already gone, proving self-heal is durable.
        let loaded_again = store.load_push_tokens().unwrap();
        assert_eq!(loaded_again.len(), 1);
    }

    #[test]
    fn migrate_pairing_ids_backfills_legacy_rows() {
        let (_dir, store) = open_test_store();
        store
            .save_pairing(&sample_pairing("legacy-daemon"))
            .unwrap(); // pairing_id = ""
        let n = store.migrate_pairing_ids().unwrap();
        assert_eq!(n, 1);
        let loaded = store.load_pairings().unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(!loaded[0].pairing_id.is_empty());
        assert_eq!(
            loaded[0].pairing_id,
            tp_core::derive_legacy_pairing_id("legacy-daemon".to_string())
        );

        // Idempotent: running again should find nothing left to backfill.
        assert_eq!(store.migrate_pairing_ids().unwrap(), 0);
    }

    #[test]
    fn reset_for_test_clears_everything() {
        let (_dir, mut store) = open_test_store();
        store.create_session("s1", "/tmp", None, None).unwrap();
        store.save_pairing(&sample_pairing("d1")).unwrap();
        store.reset_for_test().unwrap();
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(store.load_pairings().unwrap().is_empty());
        assert!(store.session_dbs.is_empty());
    }
}
