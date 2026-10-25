-- Users and roles. The first administrator is not seeded here: db-manager's bootstrap step asks for it.

CREATE TABLE IF NOT EXISTS roles (
  id   serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

INSERT INTO roles (name) VALUES ('ADMIN'), ('USER') ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role_id       integer NOT NULL REFERENCES roles (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
