-- Existing in-flight logins without a binding must restart after this migration.
ALTER TABLE oauth_states ADD COLUMN browser_challenge TEXT;
ALTER TABLE handoffs ADD COLUMN browser_challenge TEXT;
ALTER TABLE handoffs ADD COLUMN session_expires_at INTEGER;
