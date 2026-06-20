// `SQLite` reads as a proper noun throughout this module's prose; clippy's
// doc_markdown heuristic flags it as a missing-backticks identifier. Suppress
// just that one pedantic lint here rather than backtick-spamming prose.
#![allow(clippy::doc_markdown)]

//! Read-only access to the daemon's SQLite store, for the daemon-less read
//! commands (status / session list / pair list / logs).
//!
//! Mirrors `packages/daemon/src/store/`:
//!   - path: `$XDG_DATA_HOME/teleprompter/vault/sessions.sqlite` (the "meta" DB),
//!     with `$XDG_DATA_HOME` falling back to `~/.local/share`
//!     (`store/config.ts:5-11`).
//!   - PRAGMA `busy_timeout = 5000` so a read coexists with the live daemon
//!     writer under WAL without raising `SQLITE_BUSY` (`store/schema.ts:58-68`).
//!   - queries: `SELECT * FROM sessions ORDER BY created_at DESC`
//!     (`store.ts:150-152`) and
//!     `SELECT daemon_id, relay_url, created_at, label FROM pairings ORDER BY
//!      created_at ASC` (`store.ts:471-488`).
//!
//! We open the DB READ-ONLY (`OpenFlags::SQLITE_OPEN_READ_ONLY`) so the CLI never
//! runs the daemon's DDL/migrations and can never become a second writer — the
//! daemon is the single SQLite writer (ADR-0003 Amendment 2 A2.4). Writes go
//! through daemon IPC, not this module.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};

/// One row of the `sessions` table (the columns the read commands use).
pub struct SessionRow {
    pub sid: String,
    pub state: String,
    pub worktree_path: Option<String>,
    pub cwd: String,
    pub updated_at: i64,
    pub claude_version: Option<String>,
    pub last_seq: i64,
}

/// One row of the `pairings` table (the columns `pair list` uses). `label` is
/// already normalized: SQL `NULL` or `""` → `None` (no label), per the daemon's
/// forgiving `decodeWireLabel` (`store.ts:47-48`, `label.ts`).
pub struct PairingRow {
    pub daemon_id: String,
    pub relay_url: String,
    pub created_at: i64,
    pub label: Option<String>,
}

/// Resolve the vault store directory: `$XDG_DATA_HOME/teleprompter/vault`, with
/// `$XDG_DATA_HOME` falling back to `~/.local/share`. Byte-for-byte the same
/// resolution as `store/config.ts:getStoreDir` — deliberately NOT the `dirs`
/// crate default (on macOS that is `~/Library/Application Support`, which would
/// miss the daemon's `~/.local/share` DB).
fn store_dir() -> Option<PathBuf> {
    let data_home = match std::env::var("XDG_DATA_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            let home = std::env::var_os("HOME")?;
            PathBuf::from(home).join(".local").join("share")
        }
    };
    Some(data_home.join("teleprompter").join("vault"))
}

/// Path to the meta DB (`sessions.sqlite`), which holds BOTH the `sessions` and
/// `pairings` tables (`store.ts:91`).
fn meta_db_path() -> Option<PathBuf> {
    Some(store_dir()?.join("sessions.sqlite"))
}

/// Open the meta DB read-only with the daemon's `busy_timeout`. Returns `None` if
/// the path can't be resolved or the file doesn't exist / can't be opened
/// read-only (a not-yet-created store is a normal "no sessions/pairings" state,
/// not an error).
fn open_meta_readonly() -> Option<Connection> {
    let path = meta_db_path()?;
    // READ_ONLY: never create, never migrate, never write. If the file is
    // absent rusqlite returns an error here, which we map to None (empty store).
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // Match the daemon's 5s busy_timeout so a concurrent writer doesn't make us
    // fail with SQLITE_BUSY.
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    Some(conn)
}

/// List sessions, newest first. Empty vec if the store doesn't exist yet.
/// Mirrors `Store.listSessions` (`SELECT * FROM sessions ORDER BY created_at
/// DESC`).
pub fn list_sessions() -> Vec<SessionRow> {
    let Some(conn) = open_meta_readonly() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT sid, state, worktree_path, cwd, updated_at, claude_version, last_seq \
         FROM sessions ORDER BY created_at DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(SessionRow {
            sid: r.get(0)?,
            state: r.get(1)?,
            worktree_path: r.get(2)?,
            cwd: r.get(3)?,
            updated_at: r.get(4)?,
            claude_version: r.get(5)?,
            last_seq: r.get(6)?,
        })
    });
    match rows {
        Ok(mapped) => mapped.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// Get a single session row by exact sid. Returns `None` if the store doesn't
/// exist yet or the sid is not found. Mirrors `Store.getSession(sid)`
/// (`store.ts:227-229`: `SELECT * FROM sessions WHERE sid = ?`).
pub fn get_session(sid: &str) -> Option<SessionRow> {
    let conn = open_meta_readonly()?;
    let mut stmt = conn
        .prepare(
            "SELECT sid, state, worktree_path, cwd, updated_at, claude_version, last_seq \
             FROM sessions WHERE sid = ?",
        )
        .ok()?;
    stmt.query_row([sid], |r| {
        Ok(SessionRow {
            sid: r.get(0)?,
            state: r.get(1)?,
            worktree_path: r.get(2)?,
            cwd: r.get(3)?,
            updated_at: r.get(4)?,
            claude_version: r.get(5)?,
            last_seq: r.get(6)?,
        })
    })
    .ok()
}

// ---------------------------------------------------------------------------
// Per-session record DB helpers (for `tp logs`)
// ---------------------------------------------------------------------------

/// One row from the per-session `records` table. `payload` is the raw bytes
/// stored as a BLOB — the daemon writes raw PTY bytes (io) and UTF-8 JSON
/// (event); we pass them through without re-encoding.
///
/// Mirrors `StoredRecord` in `packages/daemon/src/store/session-db.ts:5-12`.
pub struct RecordRow {
    pub seq: i64,
    pub kind: String,
    pub ts: i64,
    #[allow(dead_code)]
    pub ns: Option<String>,
    #[allow(dead_code)]
    pub name: Option<String>,
    pub payload: Vec<u8>,
}

/// Path to the per-session SQLite file.
/// Mirrors `store.ts:172,188`: `join(storeDir, "sessions", "<sid>.sqlite")`.
pub fn session_db_path(sid: &str) -> Option<PathBuf> {
    Some(store_dir()?.join("sessions").join(format!("{sid}.sqlite")))
}

/// Open a per-session DB read-only. Returns `None` if the file doesn't exist
/// (treat as "no records yet" — keep polling).
///
/// READ-ONLY constraint: the Bun `SessionDb` constructor RUNS `RECORDS_DDL`
/// (creates the table). We MUST NOT run DDL; we just open and query. If the
/// `.sqlite` file is absent, return `None` (empty tail). The daemon creates
/// the file when the first record arrives.
pub fn open_session_db_readonly(sid: &str) -> Option<Connection> {
    let path = session_db_path(sid)?;
    if !path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    Some(conn)
}

/// Fetch records with `seq > after_seq`, ordered by seq ascending, up to
/// `limit` rows. Mirrors `SessionDb.getRecordsFrom(seq, limit)`:
/// `"SELECT seq, kind, ts, ns, name, payload FROM records WHERE seq > ?
///   ORDER BY seq LIMIT ?"` (`session-db.ts:31-36, 55-56`).
///
/// Returns empty vec on any error (including table-not-yet-created, which
/// means the daemon hasn't written the first record yet).
pub fn records_from(conn: &Connection, after_seq: i64, limit: i64) -> Vec<RecordRow> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT seq, kind, ts, ns, name, payload \
         FROM records WHERE seq > ? ORDER BY seq LIMIT ?",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([after_seq, limit], |r| {
        Ok(RecordRow {
            seq: r.get(0)?,
            kind: r.get(1)?,
            ts: r.get(2)?,
            ns: r.get(3)?,
            name: r.get(4)?,
            payload: r.get(5)?,
        })
    });
    match rows {
        Ok(mapped) => mapped.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// List pairings, oldest first. Empty vec if the store doesn't exist yet.
/// Mirrors `Store.listPairings`. `label` is normalized: `NULL`/`""` → `None`.
pub fn list_pairings() -> Vec<PairingRow> {
    let Some(conn) = open_meta_readonly() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT daemon_id, relay_url, created_at, label \
         FROM pairings ORDER BY created_at ASC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        let raw_label: Option<String> = r.get(3)?;
        Ok(PairingRow {
            daemon_id: r.get(0)?,
            relay_url: r.get(1)?,
            created_at: r.get(2)?,
            // decodeWireLabel: NULL or empty string both mean "no label".
            label: raw_label.filter(|s| !s.is_empty()),
        })
    });
    match rows {
        Ok(mapped) => mapped.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    // Build an in-memory meta DB with the daemon's schema + seed rows, then
    // drive the row-mapping logic by pointing the readers at it directly. We
    // can't easily redirect store_dir() in a parallel test, so test the SQL +
    // mapping by replicating open+query here against a temp file.
    fn seed_meta(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
               sid TEXT PRIMARY KEY, state TEXT NOT NULL, worktree_path TEXT,
               cwd TEXT NOT NULL, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, claude_version TEXT,
               last_seq INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE pairings (
               daemon_id TEXT PRIMARY KEY, relay_url TEXT NOT NULL,
               relay_token TEXT NOT NULL DEFAULT '', registration_proof TEXT NOT NULL DEFAULT '',
               public_key BLOB NOT NULL DEFAULT x'', secret_key BLOB NOT NULL DEFAULT x'',
               pairing_secret BLOB NOT NULL DEFAULT x'', created_at INTEGER NOT NULL, label TEXT);
             INSERT INTO sessions VALUES ('sess-a','running','/wt/a','/cwd/a',100,200,'1.2.3',5);
             INSERT INTO sessions VALUES ('sess-b','stopped',NULL,'/cwd/b',150,250,NULL,0);
             INSERT INTO pairings (daemon_id,relay_url,created_at,label) VALUES ('did-1','wss://r','300','phone');
             INSERT INTO pairings (daemon_id,relay_url,created_at,label) VALUES ('did-2','wss://r','400',NULL);
             INSERT INTO pairings (daemon_id,relay_url,created_at,label) VALUES ('did-3','wss://r','500','');",
        )
        .unwrap();
    }

    #[test]
    fn session_rows_map_correctly() {
        let dir = std::env::temp_dir().join(format!("tp-cli-test-sess-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.sqlite");
        seed_meta(&path);

        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT sid, state, worktree_path, cwd, updated_at, claude_version, last_seq \
                 FROM sessions ORDER BY created_at DESC",
            )
            .unwrap();
        let rows: Vec<SessionRow> = stmt
            .query_map([], |r| {
                Ok(SessionRow {
                    sid: r.get(0)?,
                    state: r.get(1)?,
                    worktree_path: r.get(2)?,
                    cwd: r.get(3)?,
                    updated_at: r.get(4)?,
                    claude_version: r.get(5)?,
                    last_seq: r.get(6)?,
                })
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        // created_at DESC → sess-b (150) before sess-a (100).
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].sid, "sess-b");
        assert_eq!(rows[0].worktree_path, None);
        assert_eq!(rows[0].claude_version, None);
        assert_eq!(rows[1].sid, "sess-a");
        assert_eq!(rows[1].worktree_path.as_deref(), Some("/wt/a"));
        assert_eq!(rows[1].claude_version.as_deref(), Some("1.2.3"));
        assert_eq!(rows[1].last_seq, 5);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pairing_label_normalizes_null_and_empty() {
        let dir = std::env::temp_dir().join(format!("tp-cli-test-pair-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.sqlite");
        seed_meta(&path);

        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT daemon_id, relay_url, created_at, label FROM pairings ORDER BY created_at ASC",
            )
            .unwrap();
        let rows: Vec<PairingRow> = stmt
            .query_map([], |r| {
                let raw: Option<String> = r.get(3)?;
                Ok(PairingRow {
                    daemon_id: r.get(0)?,
                    relay_url: r.get(1)?,
                    created_at: r.get(2)?,
                    label: raw.filter(|s| !s.is_empty()),
                })
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        // created_at ASC → did-1 (300), did-2 (400), did-3 (500).
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].label.as_deref(), Some("phone")); // set
        assert_eq!(rows[1].label, None); // NULL → none
        assert_eq!(rows[2].label, None); // "" → none

        std::fs::remove_dir_all(&dir).ok();
    }
}
