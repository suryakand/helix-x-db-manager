-- A table that belongs to a user, so an import has a foreign key to check.

CREATE TABLE IF NOT EXISTS notes (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Optional: record this file in the ledger, so running it by hand (psql -f) still leaves a row.
-- db-manager adopts a 'self-recorded' row instead of running the file again.
INSERT INTO schema_migrations (version, checksum, applied_by)
VALUES ('002_create_notes', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
