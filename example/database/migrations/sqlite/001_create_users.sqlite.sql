-- The sqlite twin of 001_create_users.sql.

CREATE TABLE IF NOT EXISTS roles (
  id   integer PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL UNIQUE
);

INSERT INTO roles (name) VALUES ('ADMIN'), ('USER') ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id            integer PRIMARY KEY AUTOINCREMENT,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role_id       integer NOT NULL REFERENCES roles (id),
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
