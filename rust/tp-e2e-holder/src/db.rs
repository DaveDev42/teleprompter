//! Read-only session-DB polls against the isolated daemon's per-session store.
//!
//! The daemon writes records in WAL mode, so a short-lived read-only opener
//! from THIS process sees committed writes without colliding with the writer.
//! The path layout is fixed by the daemon's store config
//! (`<XDG_DATA_HOME>/teleprompter/vault` + `sessions/<sid>.sqlite`) — the same
//! SoT the harness asserts on later.
//!
//! Every helper degrades soft (0 / false / "") on a missing DB or any read
//! error (transient WAL race) — the callers poll, so a miss just means "keep
//! waiting". Never a false pass/fail.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};

use crate::envcfg::env_nonempty;

fn data_home() -> PathBuf {
    if let Some(d) = env_nonempty("XDG_DATA_HOME") {
        return PathBuf::from(d);
    }
    match env_nonempty("HOME") {
        Some(home) => PathBuf::from(home).join(".local").join("share"),
        None => PathBuf::from("."),
    }
}

fn session_db_path(sid: &str) -> PathBuf {
    data_home()
        .join("teleprompter")
        .join("vault")
        .join("sessions")
        .join(format!("{sid}.sqlite"))
}

/// Read-only + no-mutex open: never creates the file, never takes a write lock
/// against the daemon (WAL readers don't block). Same flags tp-cli uses.
fn open_ro(sid: &str) -> Option<Connection> {
    Connection::open_with_flags(
        session_db_path(sid),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// Count records of a given (kind, name). 0 on any miss/error.
pub fn count_records(sid: &str, kind: &str, name: &str) -> i64 {
    let count = || -> Option<i64> {
        let db = open_ro(sid)?;
        db.query_row(
            "SELECT COUNT(*) AS c FROM records WHERE kind = ?1 AND name = ?2",
            [kind, name],
            |row| row.get(0),
        )
        .ok()
    };
    count().unwrap_or(0)
}

/// True once the per-session DB exists WITH its `records` table (a half-created
/// DB — file present, schema not applied — reads as not ready). An empty table
/// still counts as ready, matching the Bun holder's `.get()` returning null
/// without throwing.
pub fn session_db_ready(sid: &str) -> bool {
    let probe = || -> Option<bool> {
        let db = open_ro(sid)?;
        let mut stmt = db.prepare("SELECT 1 FROM records LIMIT 1").ok()?;
        let mut rows = stmt.query([]).ok()?;
        // Row or no row are both fine — only a query error means "not ready".
        rows.next().ok()?;
        Some(true)
    };
    probe().unwrap_or(false)
}

/// Concatenate the most recent `limit` io-record payloads (ANSI left intact —
/// the dialog driver only substring-matches on human-readable option labels,
/// which survive the escapes). Rows come newest-first; joined oldest-first so
/// multi-record dialogs read in order. Latin1 decode (byte → U+00xx) mirrors
/// Bun `Buffer.toString("latin1")` — lossless for the ASCII labels we match.
pub fn read_recent_io(sid: &str, limit: u32) -> String {
    let read = || -> Option<String> {
        let db = open_ro(sid)?;
        let mut stmt = db
            .prepare("SELECT payload FROM records WHERE kind = 'io' ORDER BY seq DESC LIMIT ?1")
            .ok()?;
        let payloads: Vec<Vec<u8>> = stmt
            .query_map([limit], |row| row.get::<_, Vec<u8>>(0))
            .ok()?
            .filter_map(Result::ok)
            .collect();
        let mut text = String::new();
        for payload in payloads.iter().rev() {
            text.extend(payload.iter().map(|&b| char::from(b)));
        }
        Some(text)
    };
    read().unwrap_or_default()
}
