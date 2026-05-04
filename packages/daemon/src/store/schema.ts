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
  label TEXT
);
`;

export const PAIRINGS_MIGRATIONS: string[] = [
  `ALTER TABLE pairings ADD COLUMN label TEXT;`,
];

export const PRAGMAS = [
  "PRAGMA journal_mode = DELETE;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA cache_size = -2000;",
];
