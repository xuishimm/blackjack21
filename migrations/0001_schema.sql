CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  code       TEXT    PRIMARY KEY,
  host_id    INTEGER NOT NULL REFERENCES users(id),
  mode       TEXT    NOT NULL CHECK(mode IN ('vsDealer','vsPlayers')),
  phase      TEXT    NOT NULL DEFAULT 'lobby',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
