//! Store schema — DDL + PRAGMA constants.
//!
//! **Copied byte-for-byte from `packages/daemon/src/store/schema.ts`.** These
//! strings are load-bearing: a differential parity gate opens the same
//! on-disk `sessions.sqlite` / `<sid>.sqlite` files this daemon writes and
//! diffs the resulting schema/pragma state against the Bun path. Do not
//! reformat, reorder, or "clean up" whitespace here — match the TS source
//! exactly, including the leading/trailing newlines inside the template
//! literals.

/// `SESSIONS_DDL` — verbatim from schema.ts.
pub const SESSIONS_DDL: &str = "
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'running',
  worktree_path TEXT,
  cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claude_version TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0
);
";

/// `RECORDS_DDL` — verbatim from schema.ts.
pub const RECORDS_DDL: &str = "
CREATE TABLE IF NOT EXISTS records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ns TEXT,
  name TEXT,
  payload BLOB NOT NULL
);
";

/// `PAIRINGS_DDL` — verbatim from schema.ts.
pub const PAIRINGS_DDL: &str = "
CREATE TABLE IF NOT EXISTS pairings (
  daemon_id TEXT PRIMARY KEY,
  relay_url TEXT NOT NULL,
  relay_token TEXT NOT NULL,
  registration_proof TEXT NOT NULL,
  public_key BLOB NOT NULL,
  secret_key BLOB NOT NULL,
  pairing_secret BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  label TEXT,
  pairing_id TEXT,
  hostname TEXT
);
";

/// `PAIRINGS_MIGRATIONS` — verbatim from schema.ts (ADD COLUMN only; probed
/// before running, see `Store::open`).
pub const PAIRINGS_MIGRATIONS: &[&str] = &[
    "ALTER TABLE pairings ADD COLUMN label TEXT;",
    "ALTER TABLE pairings ADD COLUMN pairing_id TEXT;",
    "ALTER TABLE pairings ADD COLUMN hostname TEXT;",
];

/// `PAIRING_CONFIRMATIONS_DDL` — verbatim from schema.ts.
pub const PAIRING_CONFIRMATIONS_DDL: &str = "
CREATE TABLE IF NOT EXISTS pairing_confirmations (
  daemon_id TEXT NOT NULL,
  frontend_id TEXT NOT NULL,
  pct BLOB NOT NULL,
  frontend_pk BLOB NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (daemon_id, frontend_id)
);
";

/// `PUSH_TOKENS_DDL` — verbatim from schema.ts.
pub const PUSH_TOKENS_DDL: &str = "
CREATE TABLE IF NOT EXISTS push_tokens (
  frontend_id TEXT PRIMARY KEY,
  daemon_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// `PRAGMAS` — run in this order on EVERY connection open (metaDb and every
/// `SessionDb`). Verbatim from schema.ts.
pub const PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL;",
    "PRAGMA synchronous = NORMAL;",
    "PRAGMA cache_size = -2000;",
    "PRAGMA busy_timeout = 5000;",
];
