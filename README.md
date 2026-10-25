# @helix-x/db-manager

Database migrations from plain, numbered SQL files, for **PostgreSQL** and **SQLite**. It comes with
an interactive CLI, and you can also call it from your own code.

**What it does**

| | |
|---|---|
| 🗂 **Migrate** | Runs `001_….sql`, `002_….sql`, … in order. Each database remembers which files it has had (in a *ledger* table), so only new files run. |
| 👤 **Bootstrap** | Asks for data that must not live in a SQL file, such as the first admin's email and password, once, on a new database. |
| 📤 **Export** | Writes the whole database (schema and data) to one `.sql` file. |
| 📥 **Import** | Loads such a file into an empty database, or replaces the data in an existing one. It checks the file first, and a dry run changes nothing. |
| 🧭 **Menu or flags** | Run `db-manager` with no arguments for a menu, or pass a command for scripts, CI and containers. |

---

## Contents

1. [Requirements](#requirements)
2. [Getting started (5 minutes)](#getting-started-5-minutes)
3. [Add a config file](#add-a-config-file)
4. [Create the first admin with a bootstrap step](#create-the-first-admin-with-a-bootstrap-step)
5. [Everyday tasks](#everyday-tasks)
6. [Rules for migration files](#rules-for-migration-files)
7. [Export and import in detail](#export-and-import-in-detail)
8. [CLI reference](#cli-reference)
9. [Configuration reference](#configuration-reference)
10. [Using it from code](#using-it-from-code)
11. [Troubleshooting](#troubleshooting)
12. [Development](#development) (including [using a local build in another project](#use-a-local-build-in-another-project))

A complete, runnable project is in `example/` (start with [`example/db-manager.config.mjs`](example/db-manager.config.mjs)).

---

## Requirements

- **Node.js 22** or newer
- **TypeORM 0.3.x**, plus the driver for your database: `pg` for PostgreSQL or `sqlite3` for SQLite
- **PostgreSQL export and import only:** the client tools `pg_dump` and `psql`, at the same major
  version as your server or newer. Migrations do not need them.
  - macOS: `brew install libpq`
  - Debian/Ubuntu: `apt install postgresql-client`
  - Alpine: `apk add postgresql-client`

---

## Getting started (5 minutes)

This walkthrough uses SQLite, so you do not need a database server. The PostgreSQL steps are shown
next to each one.

### Step 1: Install

```bash
npm install @helix-x/db-manager typeorm
npm install sqlite3        # for SQLite
npm install pg             # for PostgreSQL
```

`typeorm`, `pg` and `sqlite3` are peer dependencies, so the package uses your app's copies.

### Step 2: Create the migrations folder

```bash
mkdir -p database/migrations/sqlite
```

PostgreSQL files go in `database/migrations/`. Their SQLite versions go in
`database/migrations/sqlite/` and end in `.sqlite.sql`. You only need the folder for the database you
use.

```
your-app/
├── .env
├── package.json
└── database/
    └── migrations/
        ├── 000_create_schema_migrations.sql           ← PostgreSQL
        ├── 001_create_users.sql
        └── sqlite/
            ├── 000_create_schema_migrations.sqlite.sql ← SQLite
            └── 001_create_users.sqlite.sql
```

### Step 3: Add the ledger file (`000`)

The ledger is the table that records which files a database has had. File `000` creates it, and
db-manager runs it first on a new database. Copy this as it is.

<details open>
<summary><b>SQLite:</b> <code>database/migrations/sqlite/000_create_schema_migrations.sqlite.sql</code></summary>

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  applied_by text,
  baselined  integer NOT NULL DEFAULT 0
);
```
</details>

<details>
<summary><b>PostgreSQL:</b> <code>database/migrations/000_create_schema_migrations.sql</code></summary>

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text,
  baselined  boolean NOT NULL DEFAULT false
);
```
</details>

### Step 4: Write your first migration

<details open>
<summary><b>SQLite:</b> <code>database/migrations/sqlite/001_create_users.sqlite.sql</code></summary>

```sql
CREATE TABLE IF NOT EXISTS users (
  id            integer PRIMARY KEY AUTOINCREMENT,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```
</details>

<details>
<summary><b>PostgreSQL:</b> <code>database/migrations/001_create_users.sql</code></summary>

```sql
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```
</details>

### Step 5: Tell it which database to use

Create `.env` in the project root:

```bash
# SQLite: the database file will be ./database/database.sqlite
DATABASE_TYPE=sqlite
DATABASE_FOLDER=database
```

```bash
# PostgreSQL
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=app
DATABASE_PASSWORD=secret
DATABASE_DBNAME=app
```

> Add `.env` to `.gitignore`. A variable already set in your shell always wins over `.env`.

### Step 6: Run it

```bash
npx db-manager status      # what has run and what is pending (read only)
npx db-manager migrate     # apply the pending files
```

You should see something like:

```
---------------- db-manager target ----------------
  Config         (none -- defaults)
  Env file       .env
  NODE_ENV       (unset)
  Database type  sqlite
  Database       …/database/database.sqlite (does not exist -- will be created)
  Synchronize    false
  Migrations     database/migrations
  Action         apply
---------------------------------------------------

==> new database: created schema_migrations; building it from 000_create_schema_migrations
==> applying 000_create_schema_migrations
==> applying 001_create_users
==> applied 2 file(s)
```

On a terminal it asks you to confirm before writing.

That's it. Next time, add `002_….sql` and run `migrate` again: only the new file runs.

### Step 7 (recommended): Add npm scripts

```json
{
  "scripts": {
    "db": "db-manager",
    "db:status": "db-manager status",
    "db:migrate": "db-manager migrate",
    "db:export": "db-manager export"
  }
}
```

Now `npm run db` opens the menu, and `npm run db:migrate -- --dry-run` passes extra flags through.

---

## Add a config file

**You don't need one** while the defaults fit. Add `db-manager.config.mjs` to the project root when
you want to change a folder, name the SQLite file, or add a [bootstrap step](#create-the-first-admin-with-a-bootstrap-step).

### Minimal config

```js
// db-manager.config.mjs
import { defineConfig } from '@helix-x/db-manager';

export default defineConfig({
  sqlite: { fileName: 'app.sqlite' },             // DATABASE_FOLDER/app.sqlite
  migrations: { dir: 'database/migrations' },
  command: 'npm run db:migrate --',                // how hints tell you what to run next
});
```

`defineConfig` only adds editor autocomplete and type checking. A plain `export default { … }` works
too.

### Where the config can live

The CLI looks in the current folder, then each parent folder up to the nearest `package.json`, for
the first of:

1. `db-manager.config.mjs`
2. `db-manager.config.js`
3. `db-manager.config.cjs`
4. `db-manager.config.json`
5. a `"dbManager": { … }` key in `package.json`

Or name the file with `--config path/to/file.mjs`. **Relative paths in the config are relative to the
config file's folder.**

### Common config recipes

<details>
<summary><b>Use your own environment variable names</b> (for example <code>PGHOST</code>, <code>PGUSER</code>)</summary>

```js
export default defineConfig({
  connection: (env) => ({
    type: 'postgres',
    host: env.PGHOST ?? 'localhost',
    port: Number(env.PGPORT ?? 5432),
    user: env.PGUSER,
    password: env.PGPASSWORD ?? '',
    database: env.PGDATABASE,
  }),
});
```

To keep the default variables but under another prefix, use
`connection: { env: { prefix: 'APP_DB_' } }` (this reads `APP_DB_TYPE`, `APP_DB_HOST`, …). To rename
just one, use `connection: { env: { names: { database: 'DB_NAME' } } }`.
</details>

<details>
<summary><b>Several env files</b> (for example a shared <code>.env</code> and a personal <code>.env.local</code>)</summary>

```js
export default defineConfig({
  envFile: ['.env.local', '.env'],   // an earlier file wins; the real environment wins over both
});
```

Use `envFile: false` to read no file, and `--env-file .env.staging` to pick one for a single run.
</details>

<details>
<summary><b>A different ledger table name</b></summary>

```js
export default defineConfig({
  ledger: { table: 'app_migrations', initFile: '000_create_app_migrations' },
});
```

Rename the `000` files to match, and change the table name inside them.
</details>

<details>
<summary><b>Export file names and folder</b></summary>

```js
export default defineConfig({
  export: {
    dir: 'backups',
    fileName: '{name}_{YYYY}-{MM}-{DD}_{HH}{mm}',   // app_2026-10-25_1430.sql
  },
});
```

Tokens: `{name}` `{YYYY}` `{MM}` `{MON}` `{DD}` `{HH}` `{mm}` `{ss}`.
</details>

<details>
<summary><b>Extra lines in the target banner</b></summary>

```js
export default defineConfig({
  banner: {
    title: 'my-app database',
    localHosts: ['localhost', '127.0.0.1', 'db'],     // anything else is flagged REMOTE
    rows: (env) => [['Stack', env.STACK ?? '']],      // an empty value hides the row
  },
});
```
</details>

The full list of settings is in the [Configuration reference](#configuration-reference).

---

## Create the first admin with a bootstrap step

Some data should never be in a migration file. The classic example is the first administrator,
because the file would contain their password. A **bootstrap step** handles this:

1. `migrate` applies the pending files.
2. It calls your `needed(db)` check, for example "is the `users` table empty?"
3. If the answer is yes, it asks your questions (or reads them from environment variables).
4. It calls your `run(db, answers)` in its own transaction.

On later runs `needed` returns false, so nothing is asked.

### Full example

```js
// db-manager.config.mjs
import { randomBytes, scryptSync } from 'node:crypto';
import { defineConfig } from '@helix-x/db-manager';

// Use the same hashing your app's sign-in uses (bcrypt, argon2, ...). scrypt keeps the example dependency-free.
const hash = (password) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
};

export default defineConfig({
  command: 'npm run db:migrate --',

  bootstrap: {
    label: 'first administrator',

    // 1. Is it still needed?
    needed: (db) => db.isEmpty('users'),

    // 2. What to ask. Each answer can also come from an environment variable (`env`).
    questions: [
      {
        name: 'email',
        message: 'Admin email',
        env: 'ADMIN_EMAIL',
        transform: (v) => v.trim().toLowerCase(),
        validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'not an email address',
      },
      {
        name: 'password',
        message: 'Admin password',
        type: 'password',          // hidden while typing
        confirm: true,             // asked twice
        env: 'ADMIN_PASSWORD',
        validate: (v) => v.length >= 10 || 'at least 10 characters',
      },
    ],

    // 3. What --dry-run prints instead of writing.
    describe: (a) => `would create administrator ${a.email}`,

    // 4. Write it. This runs in a transaction; throw to roll it back.
    run: async (db, a) => {
      await db.query(
        `INSERT INTO users (email, password_hash) VALUES (${db.param(1)}, ${db.param(2)})`,
        [a.email, hash(a.password)],
      );
      return `created administrator ${a.email}`;   // printed after the run
    },
  },
});
```

### What it looks like

On a terminal:

```
$ npm run db:migrate
...                                   (target banner and confirmation)
==> applying 000_create_schema_migrations
==> applying 001_create_users
? Admin email admin@example.com
? Admin password **********
? Admin password (again) **********
==> created administrator admin@example.com
```

In CI, Docker or anywhere without a terminal, set the variables (in the shell or in `.env`) and pass
`--yes`:

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-secret' npx db-manager migrate --yes
```

If a variable is missing and there is no terminal to ask on, the run stops **before** writing
anything.

### Bootstrap reference

**Question fields**

| Field | Required | What it does |
|---|---|---|
| `name` | yes | The key in `answers` passed to `run` |
| `message` | yes | The prompt text |
| `type` | | `'input'` (default) or `'password'` (hidden input) |
| `env` | | A variable to read instead of asking. When it is set, the question is never asked, even on a terminal. |
| `confirm` | | Ask twice. If the answers differ, the run stops and nothing is changed. |
| `transform` | | Applied to the answer before `validate` |
| `validate` | | Return `true`, or a message saying why the answer is refused. A refused answer is asked again. |

**The `db` helper** passed to `needed` and `run`, which works the same on both databases:

| Member | Description |
|---|---|
| `db.query(sql, params?)` | Runs one statement and returns the rows |
| `db.param(n)` | The n-th placeholder: `$1` on PostgreSQL, `?` on SQLite |
| `db.bool(v)` | A boolean literal: `true`/`false` or `1`/`0` |
| `db.now` | SQL for the current time |
| `db.tableExists(name)` | Whether a table exists |
| `db.isEmpty(name)` | Whether a table has no rows (true when the table doesn't exist) |
| `db.driver` | `'postgres'` or `'sqlite'` |

---

## Everyday tasks

| I want to… | Run |
|---|---|
| Pick from a menu | `npx db-manager` |
| See what's applied and pending | `npx db-manager status` |
| See what `migrate` would do | `npx db-manager migrate --dry-run` |
| Apply new migrations | `npx db-manager migrate` |
| Migrate in CI or Docker | `npx db-manager migrate --yes` |
| Back up the database | `npx db-manager export` |
| Back up to a specific folder | `npx db-manager export --out ~/backups` |
| Test a restore without changing anything | `npx db-manager import backup.sql --dry-run` |
| Restore a backup | `npx db-manager import backup.sql` |
| Use another env file | `npx db-manager status --env-file .env.staging` |

### Add a new migration

1. Create the next numbered file, for example `database/migrations/003_add_notes.sql` (plus
   `sqlite/003_add_notes.sqlite.sql` if you also use SQLite).
2. Check it: `npx db-manager migrate --dry-run`
3. Apply it: `npx db-manager migrate`

### Run migrations when your app's container starts

```dockerfile
# Dockerfile
CMD ["sh", "-c", "npx db-manager migrate --yes && node dist/server.js"]
```

The real environment wins over `.env`, so a missing `.env` file in a container is fine. On
PostgreSQL an advisory lock makes sure two containers starting together never apply the same file
twice.

### Start using db-manager on an existing database

A database that already has tables but no ledger is refused until you tell db-manager which files it
already has. Say the database matches everything up to `006`:

```bash
npx db-manager init                       # 1. create the ledger table
npx db-manager baseline 006 --dry-run     # 2. preview: which files would be marked as done
npx db-manager baseline 006               # 3. mark 000-006 as done, without running them
npx db-manager migrate                    # 4. apply 007 onwards
```

Tip: put a note in the config so teammates know which prefix to use:
`baselineHint: 'Use 006 for a database restored from the production dump.'`

### Copy one database into another (for example production into local)

```bash
# 1. export from the source
npx db-manager export --env-file .env.production --out ./dumps

# 2. dry-run into the target: checks compatibility and changes nothing
npx db-manager import ./dumps/app_25_OCT_2026.sql --dry-run

# 3. the real import (asks you to type the database name to confirm)
npx db-manager import ./dumps/app_25_OCT_2026.sql

# 4. bring the schema up to date, if the dump is older than your code
npx db-manager migrate
```

> ⚠️ Import **replaces** the data in the tables it loads and makes no backup of its own. Run `export`
> on the target first if you might need its data.

---

## Rules for migration files

| Driver | File | Version recorded in the ledger |
|---|---|---|
| PostgreSQL | `database/migrations/NNN_name.sql` | `NNN_name` |
| SQLite | `database/migrations/sqlite/NNN_name.sqlite.sql` | `NNN_name` |

- **Files run in name order.** Use zero-padded numbers (`001`, `002`, … `010`). A version may contain
  only letters, digits, `.`, `_` and `-`.
- **A PostgreSQL file and its SQLite version share a version**, so they count as the same migration.
  A number doesn't need both.
- **Pending means "has no ledger row"**, not "newer than the last one". If someone merges `004` after
  you have already applied `005`, `004` still runs, with a warning.
- **Each file runs in its own transaction**, together with its ledger row. If a file fails, nothing
  from it is kept and the run stops. A file that has its own `BEGIN`/`COMMIT`, or uses
  `CONCURRENTLY`, runs as written and is recorded once it succeeds.
- **✋ Never edit a file that has been applied.** Its checksum changes, `status` shows it as
  `CHANGED`, and it does **not** run again. Put the change in a new file. (Files that were marked done
  by `baseline` are the exception: their checksum is just updated.)
- **Write files that can safely run twice**: `CREATE TABLE IF NOT EXISTS`,
  `INSERT … ON CONFLICT DO NOTHING`. Then running one by hand is harmless.
- **Safety nets:** PostgreSQL takes an advisory lock, so two runs can't collide. SQLite copies the
  database file to `<file>.pre-migrate-<time>` before applying anything. That copy is your undo.

<details>
<summary><b>Optional: files that record themselves</b> (so <code>psql -f</code> by hand still updates the ledger)</summary>

```sql
-- at the end of 002_create_notes.sql
INSERT INTO schema_migrations (version, checksum, applied_by)
VALUES ('002_create_notes', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
```

`migrate` adopts such a row: it writes the real checksum and doesn't run the file again.
</details>

---

## Export and import in detail

### Export

```bash
npx db-manager export                                # → database/exports/<db>_25_OCT_2026.sql
npx db-manager export --out ~/backups --column-inserts
```

- Writes **one plain SQL file** with the schema and all data.
- **Never overwrites.** A second export on the same day gets `_2`, `_3`, …
- Writes to `.partial` first and renames when complete, so a half-written file is never mistaken for
  a backup.
- **Only the owner can read the file** (mode `600`), because dumps usually contain password hashes and
  tokens.
- PostgreSQL uses `pg_dump --format=plain --no-owner --no-privileges` (rows as `COPY`, or `INSERT`s
  with `--column-inserts`). SQLite writes the same shape as `.dump`: tables, then `INSERT`s, then
  indexes, triggers and views.

### Import

Import accepts **plain SQL** from the **same kind of database**: a db-manager export, a `pg_dump`
plain-format dump, or `sqlite3 my.db .dump`. Compressed files and custom-format archives are refused.

| The target database is… | What happens |
|---|---|
| **empty** (no tables except the ledger) | The whole dump runs: schema, data, indexes, constraints and its ledger. |
| **already has a schema** | The dump's `CREATE`/`ALTER` statements are skipped. The dump's tables are checked, emptied and reloaded. The target keeps its own ledger. Tables that are not in the dump are left alone. |

**Safety checks.** Before writing, import compares the dump with the target. It **stops** (exit 1,
nothing written) if the dump has a table or column the target lacks, or if the target has a
`NOT NULL` column with no default that the dump doesn't fill. Smaller differences are warnings.

**Integrity.** Everything runs in one transaction. Foreign keys are re-checked for every loaded row,
and triggers are switched off during the load and restored afterwards.

**Confirmation.** A real import lists how many rows it will delete and asks you to type the database
name. Set `import: { confirm: 'yes' }` for a plain y/N, or pass `--yes` to skip the question.

**Dumps from another server version.** Lines that would fail are adjusted: `ALTER … OWNER TO` is
skipped, as are `SET`s the server doesn't know (pg_dump 17+ writes `SET transaction_timeout`, which a
15 or 16 server rejects), and `CREATE SCHEMA public` becomes `IF NOT EXISTS`.

---

## CLI reference

```
db-manager [command] [options]
```

**Commands**

| Command | What it does |
|---|---|
| *(none)* | Opens the interactive menu (needs a terminal) |
| `status` | Lists every file and what the ledger says about it. Read only. |
| `migrate` (alias `apply`) | Applies the pending files, then the bootstrap step if it is needed |
| `init` | Creates the ledger table in a database that predates it |
| `baseline <prefix>` | Marks files up to the last one starting with `<prefix>` as done, without running them |
| `export` | Writes the whole database to one SQL file |
| `import [file]` | Loads a dump and replaces the data. Asks for the file if none is given. |

**Options**

| Option | What it does |
|---|---|
| `--dry-run` | Shows what would happen. With `import`, loads the dump and rolls it back. |
| `--yes`, `-y` | Doesn't ask for confirmation. **Required when there is no terminal.** |
| `--config <file>` | The config file to use |
| `--env-file <file>` | Reads this env file instead of the configured ones |
| `--dir <path>` | The migrations folder |
| `--out <dir>` | `export`: the folder to write to |
| `--column-inserts` | `export`, PostgreSQL: rows as `INSERT`s with column lists instead of `COPY` |
| `--force` | Applies even though the ledger table exists but has no rows |
| `--init`, `--baseline <p>`, `--export`, `--import [file]` | The commands written as flags |
| `--help`, `--version` | |

**The last command given wins.** An npm script can fix a default command and still be redirected.
With `"db:migrate": "db-manager migrate"`, `npm run db:migrate -- status` reports and
`npm run db:migrate -- --baseline 006` baselines.

**It always shows the target first.** Before touching anything, the CLI prints which database it is
about to use:

```
---------------- db-manager target ----------------
  Config         db-manager.config.mjs
  Env file       .env
  NODE_ENV       (unset)
  Database type  postgres
  Host           db.internal:5432   <-- REMOTE
  Database       app   (from the environment, not the env file)
  User           app
  Synchronize    false
  Migrations     database/migrations
  Action         apply
---------------------------------------------------
```

A value that came from your shell rather than the env file is marked. That catches a forgotten
`export DATABASE_DBNAME=…`. Anything that writes asks first.

**Colors.** On a terminal, each status has its own color, so you can scan the output quickly:

| Color | Meaning |
|---|---|
| 🟡 **yellow** | `pending`, warnings, values that came from the shell |
| 🟢 green | `applied`, `applying`, `adopted`, `nothing pending` |
| 🔵 **cyan** | dry-run lines: `would apply`, `would adopt`, `would create`, … |
| 🔴 **red** | `CHANGED`, `<-- REMOTE`, `db-manager failed:` |
| 🔷 blue / 🟣 magenta | `baseline` / `no file` |

Output that is piped or redirected stays plain text. Set `NO_COLOR=1` to turn colors off on a
terminal too.

**Exit codes:** `0` success · `1` refused or failed (including a dry-run import that found the dump
incompatible, so you can use it as a check in scripts) · `130` cancelled at a prompt.

---

## Configuration reference

Every field is optional. The values shown are the defaults.

```js
// db-manager.config.mjs
import { defineConfig } from '@helix-x/db-manager';

export default defineConfig({
  rootDir: '.',                               // where relative paths start (default: this file's folder)
  envFile: ['.env'],                          // or a string, or false for none
  command: 'db-manager migrate',              // how hints name the command to run next

  // Which database: environment variables...
  connection: { env: { prefix: 'DATABASE_' }, defaultType: 'sqlite' },
  // ...or a function: connection: (env) => ({ type: 'postgres', host, port, user, password, database })
  sqlite: { baseDir: '.', fileName: 'database.sqlite' },

  schema: 'public',                           // PostgreSQL schema of your tables
  migrations: {
    dir: 'database/migrations',
    dirEnv: 'MIGRATIONS_DIR',                 // a variable that overrides dir; false to disable
    postgres: { folder: '.', suffix: '.sql' },
    sqlite: { folder: 'sqlite', suffix: '.sqlite.sql' },
  },
  ledger: { table: 'schema_migrations', initFile: '000_create_schema_migrations' },
  lockKey: 4172207311,                        // PostgreSQL advisory lock key
  baselineHint: undefined,                    // extra advice shown when a baseline is needed

  export: {
    dir: 'database/exports',
    dirEnv: 'DATABASE_EXPORT_DIR',
    fileName: '{name}_{DD}_{MON}_{YYYY}',
    fileMode: 0o600,
  },
  import: { confirm: 'name' },                 // 'name' = type the database name; 'yes' = y/N

  pgTools: {                                  // where to find pg_dump / psql
    binDir: undefined,
    binDirEnv: 'PG_BIN_DIR',
    extraDirs: [],
    homebrew: true,
  },

  banner: {
    title: 'db-manager target',
    localHosts: ['localhost', '127.0.0.1', '::1', 'postgres'],
    rows: undefined,                          // (env) => [['Label', 'value'], ...]
  },

  bootstrap: undefined,                       // see "Create the first admin with a bootstrap step"
});
```

The generated API docs (`npm run docs`) describe every field under `DbManagerConfig`.

### Environment variables

| Variable | Used for | Default |
|---|---|---|
| `DATABASE_TYPE` | `postgres` or `sqlite` | `sqlite` |
| `DATABASE_HOST` | PostgreSQL host | |
| `DATABASE_PORT` | PostgreSQL port | `5432` |
| `DATABASE_USER` | PostgreSQL user | |
| `DATABASE_PASSWORD` | PostgreSQL password | |
| `DATABASE_DBNAME` | PostgreSQL database name | |
| `DATABASE_FOLDER` | SQLite: the folder that holds `sqlite.fileName` | |
| `DATABASE_FILE` | SQLite: the full file path (wins over the folder) | |
| `DATABASE_SYNC` | `true` if TypeORM `synchronize` builds your tables (migrate then only warns) | |
| `MIGRATIONS_DIR` | Overrides `migrations.dir` (relative to the working directory) | |
| `DATABASE_EXPORT_DIR` | Overrides `export.dir` (relative to the config folder) | |
| `PG_BIN_DIR` | Folder containing `pg_dump` and `psql` | `PATH`, then Homebrew |

The `DATABASE_` names follow `connection.env.prefix`. The others can be renamed, or turned off with
`false`, using `dirEnv` and `binDirEnv`.

**Which setting wins**, from lowest to highest:

| Setting | Config | Env variable | Flag |
|---|---|---|---|
| Env files | `envFile` | | `--env-file` |
| Migrations folder | `migrations.dir` | `MIGRATIONS_DIR` | `--dir` |
| Export folder | `export.dir` | `DATABASE_EXPORT_DIR` | `--out` |
| pg tools folder | `pgTools.binDir` | `PG_BIN_DIR` | |

---

## Using it from code

The engine works on a TypeORM `DataSource`. The package ships both ESM and CommonJS builds, so
`import` and `require` both work.

```ts
import { DataSource } from 'typeorm';
import { exportDatabase, importDatabase, migrateSchema } from '@helix-x/db-manager';

const ds = await new DataSource({
  type: 'postgres', host: 'localhost', username: 'app', password: 'secret', database: 'app',
}).initialize();

const settings = { ledger: { table: 'schema_migrations' }, command: 'npm run db:migrate --' };

// Apply pending migrations
const { applied } = await migrateSchema(ds, { action: 'apply', dir: 'database/migrations', settings });
console.log('applied', applied);

// Export, then check the file with a dry-run import
const file = await exportDatabase(ds, { dir: 'backups', name: 'app', settings });
const { plan } = await importDatabase(ds, { file, dryRun: true, settings });
```

`migrateSchema` also accepts `action: 'status' | 'baseline' | 'init'`, `dryRun`, `baselinePrefix`,
`bootstrap`, and `log` / `warn` callbacks.

To get from a config file to a connected `DataSource` the way the CLI does, use `loadConfig()`,
`loadEnvFiles()`, `resolveConnection()` and `openDataSource()`.

---

## Troubleshooting

<details>
<summary><b>"not on a terminal, so cannot ask for confirmation" (CI, Docker)</b></summary>

Without a terminal, anything that writes needs `--yes`. A bootstrap step also needs every question's
`env` variable to be set.
</details>

<details>
<summary><b>"schema_migrations does not exist in this database"</b></summary>

The database already has tables but no ledger. Follow
[Start using db-manager on an existing database](#start-using-db-manager-on-an-existing-database).
</details>

<details>
<summary><b>A file shows as <code>CHANGED</code> in status</b></summary>

Someone edited a file after it was applied. Undo the edit (for example with `git checkout`) and put the
change in a new migration file.
</details>

<details>
<summary><b>It is connecting to the wrong database</b></summary>

Look at the target banner. A value marked *(from the environment, not the env file)* comes from your
shell. Run `unset DATABASE_DBNAME` (or whichever variable it is), or open a new terminal.
</details>

<details>
<summary><b><code>pg_dump</code> not found, or "server version mismatch"</b></summary>

Install the PostgreSQL client tools, at the same major version as the server or newer (see
[Requirements](#requirements)). If they are not on your `PATH`, set `PG_BIN_DIR`, for example
`PG_BIN_DIR=/opt/homebrew/opt/libpq/bin`.
</details>

<details>
<summary><b>Undo a SQLite migration</b></summary>

Before applying anything, `migrate` saves a copy next to the database:
`<file>.pre-migrate-<time>`. Stop your app and copy that file back over the database file.
</details>

---

## Development

```bash
npm install
npm run build          # tsup → dist/ (ESM + CJS library, ESM CLI)
npm run typecheck
npm test               # vitest; SQLite always, PostgreSQL when PG_TEST_URL is set
npm run docs           # typedoc → docs/
```

**PostgreSQL tests** need `pg_dump` and `psql` installed, and a server where the user can create
databases:

```bash
docker run -d --rm --name dbm-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=dbm -e POSTGRES_PASSWORD=dbm postgres:15
PG_TEST_URL=postgres://dbm:dbm@127.0.0.1:55432/postgres npm test
```

**Try the example** against your local build:

```bash
npm run build
cd example
cp .env.example .env
node ../dist/cli.js            # menu
node ../dist/cli.js migrate    # builds the database and asks for the first admin
```

### Use a local build in another project

There are two ways to try your changes in an app (for example `ef-backend`) before publishing.

#### Option 1: Pack it into a `.tgz` and install that

This works most like a real install from the registry.

**1. In this repo, create the package file:**

```bash
cd helix-x-db-manager
npm pack
# → helix-x-db-manager-0.1.0.tgz
```

`npm pack` runs the `prepack` script first, which deletes `dist/` and rebuilds it, so you don't need
to build separately. The package contains only `dist/`, `README.md`, `LICENSE` and `package.json`.
`*.tgz` is already in `.gitignore`.

**2. In your app, install it plus the database driver you use:**

```bash
cd ../ef-backend
npm install ../helix-x-db-manager/helix-x-db-manager-0.1.0.tgz
npm install typeorm pg        # use sqlite3 instead of pg for SQLite; skip any you already have
```

This adds a line to the app's `package.json`:

```json
"@helix-x/db-manager": "file:../helix-x-db-manager/helix-x-db-manager-0.1.0.tgz"
```

**3. Use it:**

```bash
npx db-manager status
npx db-manager            # the menu
```

**After you change db-manager:** run `npm pack` again, then run
`npm install ../helix-x-db-manager/helix-x-db-manager-0.1.0.tgz` again in the app. If the version
number hasn't changed, npm may keep using its cached copy. In that case, run
`npm uninstall @helix-x/db-manager` first, or raise the version (`npm version patch`).

#### Option 2: `npm link`, so changes show up without reinstalling

This is better while you're still changing db-manager.

```bash
# in helix-x-db-manager
npm run build
npm link                       # registers the package globally on your machine
npm run dev                    # optional: rebuilds dist/ every time you save

# in your app
npm link @helix-x/db-manager
npx db-manager status
```

Your app now uses this folder directly, so each rebuild is picked up immediately. To go back to the
normal package, run `npm unlink @helix-x/db-manager && npm install` in the app.

> **One catch with linking:** the linked folder has its own `node_modules` with the dev copies of
> `typeorm`, `pg` and `sqlite3`. When you use the CLI that's harmless. But if your app passes its own
> TypeORM `DataSource` into `migrateSchema()`, two copies of TypeORM can conflict. If you see strange
> TypeORM errors, use Option 1.

#### Which to use

| Situation | Use |
|---|---|
| A final check before publishing, or giving the file to a teammate | Option 1 (`npm pack`) |
| Still changing db-manager and testing in the app | Option 2 (`npm link`) |

### Publish

Releases go through GitHub Actions: every push or pull request runs **CI** (typecheck, tests against
SQLite and PostgreSQL, build, docs check), and a push to `main` publishes the `package.json` version
to npmjs.org and the custom registry (`packages.allquill.com`), tags it, creates the GitHub release,
bumps the version for next time, and deploys the API docs.

See [RELEASING.md](RELEASING.md) for the one-time setup (secrets and variables), retrying a failed
release, copying a version to another registry, and publishing by hand:

```bash
npm run publish:check          # which registries already have this version
npm run publish:dry            # dry run against both registries
```

---

<sub>This package came out of EasyFreight's `ef-backend`. Its defaults (`schema_migrations`,
`DATABASE_*` variables, `NNN_name.sql` files with SQLite versions in `sqlite/`) come from that
project, and each one can be changed in the config.</sub>
