export const SESSIONS_DDL = `
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
`;

export const RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ns TEXT,
  name TEXT,
  payload BLOB NOT NULL
);
`;

export const PAIRINGS_DDL = `
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
`;

export const PAIRINGS_MIGRATIONS: string[] = [
  `ALTER TABLE pairings ADD COLUMN label TEXT;`,
  // QR v4 pairing identity (PCT redesign). Nullable: legacy rows are
  // backfilled asynchronously by Store.migratePairingIds() at daemon boot.
  `ALTER TABLE pairings ADD COLUMN pairing_id TEXT;`,
  `ALTER TABLE pairings ADD COLUMN hostname TEXT;`,
];

/**
 * Per-frontend Pairing Confirmation Tags (PCT redesign). One row per
 * (daemon_id, frontend_id) — a pairing serves N frontends and each frontend's
 * ECDH session yields a distinct tag, so this is deliberately NOT a column on
 * `pairings` (a single column would be a last-writer-wins artifact under N:N
 * and would be clobbered on every reconnect).
 */
export const PAIRING_CONFIRMATIONS_DDL = `
CREATE TABLE IF NOT EXISTS pairing_confirmations (
  daemon_id TEXT NOT NULL,
  frontend_id TEXT NOT NULL,
  pct BLOB NOT NULL,
  frontend_pk BLOB NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (daemon_id, frontend_id)
);
`;

/**
 * Sealed push tokens persisted by the daemon after receiving relay.push.token.
 * `sealed` is an opaque blob ("tpps1.<v>.<b64>") — only meaningful to the relay.
 * Daemon never stores plaintext tokens after Path X is active.
 */
export const PUSH_TOKENS_DDL = `
CREATE TABLE IF NOT EXISTS push_tokens (
  frontend_id TEXT PRIMARY KEY,
  daemon_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const PRAGMAS = [
  // WAL lets the daemon (writer) and short-lived CLI processes (readers / occasional writers)
  // share the same DB without colliding on a single-writer rollback journal.
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA cache_size = -2000;",
  // Wait up to 5s for the writer to release the lock before raising SQLITE_BUSY.
  // CLI commands open the store, do one quick op, and close — this gives them
  // headroom even when the daemon is mid-write.
  "PRAGMA busy_timeout = 5000;",
];
