-- The ledger, for sqlite: the same columns as the postgres table, in sqlite types (applied_at is
-- ISO-8601 UTC text, baselined is 0/1).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  applied_by text,
  baselined  integer NOT NULL DEFAULT 0
);
