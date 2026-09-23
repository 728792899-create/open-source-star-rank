-- Dedicated operations database; never apply this to the authentication database.
CREATE TABLE IF NOT EXISTS operations_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  revision INTEGER NOT NULL CHECK (revision > 0)
);
