-- The ledger: one row per migration file this database has had. db-manager creates it from this file
-- on a new database (and on `init`), then records this file in it like any other.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,                  -- file name without .sql
  checksum   text NOT NULL,                     -- sha256 of the file when it was applied
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text,                              -- <os user>@<host> that ran it
  baselined  boolean NOT NULL DEFAULT false     -- recorded by a baseline, never run
);
