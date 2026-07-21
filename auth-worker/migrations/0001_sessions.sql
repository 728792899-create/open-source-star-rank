CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  encrypted_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER,
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions(github_user_id);
CREATE INDEX sessions_expiry_idx ON sessions(session_expires_at);

CREATE TABLE handoffs (
  handoff_hash TEXT PRIMARY KEY,
  encrypted_session_token TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);
CREATE INDEX handoffs_expiry_idx ON handoffs(expires_at);
