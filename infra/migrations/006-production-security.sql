BEGIN;
ALTER TABLE users ADD COLUMN security_version bigint NOT NULL DEFAULT 1 CHECK (security_version > 0);
CREATE UNIQUE INDEX users_email_normalized ON users(store_id,lower(email));
-- Lookup tokens now use a purpose-bound keyed digest. Existing cookies require sign-in.
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN security_version bigint NOT NULL CHECK (security_version > 0);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(store_id,user_id);
GRANT INSERT ON users TO counter_pos_app;
GRANT UPDATE(email,display_name,password_hash,role,active,security_version) ON users TO counter_pos_app;
COMMIT;
