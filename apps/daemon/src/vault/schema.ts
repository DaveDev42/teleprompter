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

export const PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA cache_size = -2000;",
];
