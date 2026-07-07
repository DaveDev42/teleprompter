//! Per-session record store.
//!
//! Byte-exact port of `packages/daemon/src/store/session-db.ts`. Opens
//! `<sid>.sqlite`, applies the shared PRAGMAs + `RECORDS_DDL`, and exposes
//! append/select over the `records` table.

use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::schema::{PRAGMAS, RECORDS_DDL};

/// One row from the `records` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecord {
    pub seq: i64,
    pub kind: String,
    pub ts: i64,
    pub ns: Option<String>,
    pub name: Option<String>,
    pub payload: Vec<u8>,
}

/// Options for [`SessionDb::get_records_filtered`].
#[derive(Debug, Clone, Default)]
pub struct RecordsFilter {
    pub kinds: Option<Vec<String>>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<i64>,
}

/// Owns a single `<sid>.sqlite` connection. Not `Send`/`Sync` (rusqlite
/// `Connection` isn't either) — the daemon is single-threaded per store.
pub struct SessionDb {
    conn: Connection,
}

impl SessionDb {
    /// Open (or create) the session database at `path`, applying PRAGMAs +
    /// `RECORDS_DDL` in the same order as the TS constructor.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` if the connection cannot be
    /// opened or any PRAGMA/DDL statement fails.
    pub fn open<P: AsRef<Path>>(path: P) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        for pragma in PRAGMAS {
            conn.execute_batch(pragma)?;
        }
        conn.execute_batch(RECORDS_DDL)?;
        Ok(Self { conn })
    }

    /// Test-only: an in-memory `SessionDb` with `RECORDS_DDL` applied but no
    /// on-disk file (and therefore no WAL/SHM sidecars — `journal_mode=WAL`
    /// is a no-op on `:memory:`). Used by `Store` tests that need a
    /// cache-tracked sid without a real file to avoid tampering with a real
    /// connection's live WAL mapping.
    #[cfg(test)]
    pub(crate) fn open_in_memory_for_test() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(RECORDS_DDL)?;
        Ok(Self { conn })
    }

    /// Append one record. Returns the assigned `seq` (AUTOINCREMENT rowid).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on insert failure.
    pub fn append(
        &self,
        kind: &str,
        ts: i64,
        payload: &[u8],
        ns: Option<&str>,
        name: Option<&str>,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO records (kind, ts, ns, name, payload) VALUES (?, ?, ?, ?, ?)",
            params![kind, ts, ns, name, payload],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Records with `seq > seq`, ordered by `seq`, limited to `limit` (default
    /// 1000, mirroring the TS default parameter).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn get_records_from(&self, seq: i64, limit: i64) -> rusqlite::Result<Vec<StoredRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, kind, ts, ns, name, payload FROM records WHERE seq > ? ORDER BY seq LIMIT ?",
        )?;
        let rows = stmt.query_map(params![seq, limit], row_to_record)?;
        rows.collect()
    }

    /// Filtered record query. `limit` is clamped to at most 50000 (mirroring
    /// `Math.min(opts.limit ?? 50000, 50000)`).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn get_records_filtered(
        &self,
        opts: &RecordsFilter,
    ) -> rusqlite::Result<Vec<StoredRecord>> {
        let mut conditions: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(kinds) = &opts.kinds {
            if !kinds.is_empty() {
                let placeholders = kinds.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                conditions.push(format!("kind IN ({placeholders})"));
                for k in kinds {
                    params.push(Box::new(k.clone()));
                }
            }
        }
        if let Some(from) = opts.from {
            conditions.push("ts >= ?".to_string());
            params.push(Box::new(from));
        }
        if let Some(to) = opts.to {
            conditions.push("ts <= ?".to_string());
            params.push(Box::new(to));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let limit = opts.limit.unwrap_or(50_000).min(50_000);
        params.push(Box::new(limit));

        let sql = format!(
            "SELECT seq, kind, ts, ns, name, payload FROM records {where_clause} ORDER BY seq LIMIT ?"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(AsRef::as_ref).collect();
        let rows = stmt.query_map(params_from_iter(param_refs), row_to_record)?;
        rows.collect()
    }

    /// `MAX(seq)` over `records`, or 0 when the table is empty.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on query failure.
    pub fn get_last_seq(&self) -> rusqlite::Result<i64> {
        let seq: Option<i64> = self
            .conn
            .query_row("SELECT MAX(seq) as last_seq FROM records", [], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        Ok(seq.unwrap_or(0))
    }

    /// Test-only: clear all records and reset the autoincrement sequence.
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` on statement failure.
    pub fn reset_for_test(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM records", [])?;
        self.conn
            .execute("DELETE FROM sqlite_sequence WHERE name='records'", [])?;
        Ok(())
    }

    /// Explicitly close (drops the connection). Provided for symmetry with
    /// the TS `close()` — dropping `SessionDb` has the same effect.
    pub fn close(self) {
        drop(self);
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        seq: row.get(0)?,
        kind: row.get(1)?,
        ts: row.get(2)?,
        ns: row.get(3)?,
        name: row.get(4)?,
        payload: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let db = SessionDb::open(dir.path().join("s1.sqlite")).unwrap();

        let seq1 = db.append("io", 100, b"hello", None, None).unwrap();
        let seq2 = db
            .append("event", 200, b"{}", Some("hooks"), Some("Stop"))
            .unwrap();
        assert_eq!(seq1, 1);
        assert_eq!(seq2, 2);

        assert_eq!(db.get_last_seq().unwrap(), 2);

        let recs = db.get_records_from(0, 1000).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].kind, "io");
        assert_eq!(recs[0].payload, b"hello");
        assert_eq!(recs[1].ns.as_deref(), Some("hooks"));
        assert_eq!(recs[1].name.as_deref(), Some("Stop"));
    }

    #[test]
    fn get_records_from_respects_cursor_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        let db = SessionDb::open(dir.path().join("s2.sqlite")).unwrap();
        for i in 0..5 {
            db.append("io", i, b"x", None, None).unwrap();
        }
        let recs = db.get_records_from(2, 2).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].seq, 3);
        assert_eq!(recs[1].seq, 4);
    }

    #[test]
    fn get_records_filtered_by_kind_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let db = SessionDb::open(dir.path().join("s3.sqlite")).unwrap();
        db.append("io", 10, b"a", None, None).unwrap();
        db.append("event", 20, b"b", None, Some("Stop")).unwrap();
        db.append("event", 30, b"c", None, Some("Start")).unwrap();

        let filtered = db
            .get_records_filtered(&RecordsFilter {
                kinds: Some(vec!["event".to_string()]),
                from: Some(15),
                to: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|r| r.kind == "event"));
    }

    #[test]
    fn last_seq_zero_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let db = SessionDb::open(dir.path().join("s4.sqlite")).unwrap();
        assert_eq!(db.get_last_seq().unwrap(), 0);
    }

    #[test]
    fn reset_for_test_clears_and_resets_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let db = SessionDb::open(dir.path().join("s5.sqlite")).unwrap();
        db.append("io", 1, b"a", None, None).unwrap();
        db.reset_for_test().unwrap();
        assert_eq!(db.get_last_seq().unwrap(), 0);
        let seq = db.append("io", 2, b"b", None, None).unwrap();
        assert_eq!(seq, 1);
    }
}
