import type { Db } from '../engine/dialect';
import type { MigrationSource } from '../engine/settings';

/** The environment as the config's functions see it: the process environment with the env files laid under it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** A SQLite database file. */
export interface SqliteSpec {
  /** The driver. */
  type: 'sqlite';
  /** Absolute, or relative to the config's `rootDir`. */
  file: string;
  /** The ORM's synchronize is on (only produces a warning). */
  synchronize?: boolean;
}

/** A PostgreSQL database. */
export interface PostgresSpec {
  /** The driver. */
  type: 'postgres';
  /** Server host name or address. */
  host: string;
  /** Server port, usually 5432. */
  port: number;
  /** Login role. */
  user: string;
  /** Login password; empty for trust or peer authentication. */
  password: string;
  /** Database name. */
  database: string;
  /** The ORM's synchronize is on (only produces a warning). */
  synchronize?: boolean;
}

/** Which database to work on. */
export type ConnectionSpec = SqliteSpec | PostgresSpec;

/** The environment variables an env-mapped connection reads. */
export interface ConnectionEnvNames {
  /** `postgres` or `sqlite`. */
  type: string;
  /** Postgres host. */
  host: string;
  /** Postgres port (default 5432 when unset). */
  port: string;
  /** Postgres login role. */
  user: string;
  /** Postgres password. */
  password: string;
  /** Postgres database name. */
  database: string;
  /** SQLite: the folder holding `sqlite.fileName`. */
  folder: string;
  /** SQLite: the whole file path; wins over `folder`. */
  file: string;
  /** `true` when the ORM's synchronize is on. */
  sync: string;
}

/**
 * A connection read from environment variables. With the default prefix `DATABASE_` that is
 * `DATABASE_TYPE`, `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`,
 * `DATABASE_DBNAME`, `DATABASE_FOLDER`, `DATABASE_FILE` and `DATABASE_SYNC`.
 */
export interface EnvConnection {
  /** Which variables to read. */
  env: {
    /** Default `DATABASE_`. */
    prefix?: string;
    /** Individual names, when they do not follow the prefix. */
    names?: Partial<ConnectionEnvNames>;
  };
  /** Used when the type variable is unset. Default `sqlite`. */
  defaultType?: 'postgres' | 'sqlite';
}

/** One question the bootstrap step asks, or reads from the environment when there is no terminal. */
export interface BootstrapQuestion {
  /** The key in the answers passed to `run`. */
  name: string;
  /** The prompt, e.g. "Email". */
  message: string;
  /** `password` hides what is typed. Default `input`. */
  type?: 'input' | 'password';
  /** The variable read instead of asking; when set it is used even on a terminal. */
  env?: string;
  /** Ask a second time and require the same answer (for passwords). */
  confirm?: boolean;
  /** `true`, or the reason the answer is refused. */
  validate?: (value: string) => true | string;
  /** Applied to the answer before `validate`, e.g. trimming and lower-casing an email. */
  transform?: (value: string) => string;
}

/**
 * Something only a person can supply, created once at the end of a migrate run while it is still
 * missing -- typically the first administrator of a new database.
 */
export interface BootstrapConfig {
  /** For messages: "first administrator". */
  label: string;
  /** Whether it is still needed, e.g. `(db) => db.isEmpty('users')`. */
  needed: (db: Db) => Promise<boolean>;
  /** What to ask (or read from the environment), in order. */
  questions: BootstrapQuestion[];
  /** Writes it, in a transaction the engine opens. Returns a line to log. */
  run: (db: Db, answers: Record<string, string>) => Promise<string | void>;
  /** What a dry run says it would do. */
  describe?: (answers: Record<string, string>) => string;
}

/**
 * The configuration file's contents: `db-manager.config.mjs` (or `.js`, `.cjs`, `.json`, or a
 * `dbManager` key in `package.json`). Every field is optional. Relative paths are relative to
 * `rootDir`.
 */
export interface DbManagerConfig {
  /** Where relative paths start. Default: the folder the config file is in (the working directory without one). */
  rootDir?: string;
  /** Env files to read, in order; an earlier file wins, and the real environment wins over all of them. `false` reads none. Default `['.env']`. */
  envFile?: string | string[] | false;
  /** How messages name the command to run next. Default `db-manager migrate`. */
  command?: string;
  /** The database: environment variables (default), or a function of the environment. */
  connection?: EnvConnection | ((env: Env) => ConnectionSpec);
  /** For an env-mapped SQLite connection. */
  sqlite?: {
    /** Where a relative folder variable resolves from. Default `.`. */
    baseDir?: string;
    /** The file in that folder. Default `database.sqlite`. */
    fileName?: string;
  };
  /** The postgres schema the application's tables are in. Default `public`. */
  schema?: string;
  /** Where the migration files are. */
  migrations?: {
    /** Default `database/migrations`. */
    dir?: string;
    /** A variable that overrides `dir` (relative to the working directory). Default `MIGRATIONS_DIR`; `false` for none. */
    dirEnv?: string | false;
    /** Default `{ folder: '.', suffix: '.sql' }`. */
    postgres?: Partial<MigrationSource>;
    /** Default `{ folder: 'sqlite', suffix: '.sqlite.sql' }`. */
    sqlite?: Partial<MigrationSource>;
  };
  /** The table that records what each database has had. */
  ledger?: {
    /** Default `schema_migrations`. */
    table?: string;
    /** The version of the file that creates it. Default `000_create_schema_migrations`. */
    initFile?: string;
  };
  /** The postgres advisory lock key. Default `4172207311`. */
  lockKey?: number;
  /** Extra advice in the "record what this database already has" hint, e.g. which prefix to baseline. */
  baselineHint?: string;
  /** Where and how `export` writes. */
  export?: {
    /** Default `database/exports`. */
    dir?: string;
    /** A variable that overrides `dir` (relative to `rootDir`). Default `DATABASE_EXPORT_DIR`; `false` for none. */
    dirEnv?: string | false;
    /** Tokens `{name}` `{YYYY}` `{MM}` `{MON}` `{DD}` `{HH}` `{mm}` `{ss}`. Default `{name}_{DD}_{MON}_{YYYY}`. */
    fileName?: string;
    /** Default `0o600`. */
    fileMode?: number;
  };
  /** How `import` confirms. */
  import?: {
    /** Before replacing data: `name` wants the database name typed back (default); `yes` takes a y/N. */
    confirm?: 'name' | 'yes';
  };
  /** Where pg_dump and psql are (postgres export and import only). */
  pgTools?: {
    /** Folder holding pg_dump and psql. */
    binDir?: string;
    /** A variable naming that folder. Default `PG_BIN_DIR`; `false` for none. */
    binDirEnv?: string | false;
    /** More folders to look in, before `PATH`. */
    extraDirs?: string[];
    /** Look in Homebrew's libpq / postgresql@* after `PATH`. Default `true`. */
    homebrew?: boolean;
  };
  /** The block printed before anything is touched. */
  banner?: {
    /** Default `db-manager target`. */
    title?: string;
    /** Postgres hosts not flagged as remote. Default localhost, 127.0.0.1, ::1 and `postgres`. */
    localHosts?: string[];
    /** Extra rows, e.g. `(env) => [['Stack', env.STACK ?? '']]`; an empty value hides a row. */
    rows?: (env: Env) => Array<[string, string]>;
  };
  /** Run once at the end of migrate while still needed. See {@link BootstrapConfig}. */
  bootstrap?: BootstrapConfig;
}
