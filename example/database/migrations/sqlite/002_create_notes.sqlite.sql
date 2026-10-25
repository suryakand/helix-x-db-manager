-- The sqlite twin of 002_create_notes.sql.

CREATE TABLE IF NOT EXISTS notes (
  id         integer PRIMARY KEY AUTOINCREMENT,
  user_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
