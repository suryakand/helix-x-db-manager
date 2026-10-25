/**
 * The settings the engine (migrate, export, import) works with. The CLI builds them from a
 * {@link DbManagerConfig}; a program that calls the engine directly passes the parts it wants to
 * change and gets the defaults for the rest.
 */

/** Where one driver's migration files are and how they are named. */
export interface MigrationSource {
  /** Folder, relative to the migrations directory. `.` is the directory itself. */
  folder: string;
  /** File-name suffix. A file's version is its name without this suffix. */
  suffix: string;
}

/** Where `pg_dump` and `psql` are looked for, in this order. */
export interface PgToolSettings {
  /** Looked in first. */
  binDir?: string;
  /** Looked in after `binDir`, before `PATH`. */
  extraDirs: string[];
  /** Look in Homebrew's keg-only `libpq` and `postgresql@*` folders after `PATH`. Default `true`. */
  homebrew: boolean;
}

/** Everything the engine needs to know besides the database connection. */
export interface EngineSettings {
  /** The postgres schema the application's tables are in. Default `public`. */
  schema: string;
  /** The table that records which files a database has had. */
  ledger: {
    /** The table that records which files a database has had. Default `schema_migrations`. */
    table: string;
    /**
     * The version (file name without its suffix) of the file that creates the ledger. It runs first
     * on a new database and on `init`. Default `000_create_schema_migrations`.
     */
    initFile: string;
  };
  /**
   * The postgres advisory lock that migrate and import hold, so two runs never work on one database at
   * once. Advisory locks are per database, so apps on separate databases cannot block each other.
   * Default `4172207311`.
   */
  lockKey: number;
  /** Where each driver's files are, under the migrations directory. */
  migrations: {
    /** Default: the migrations directory itself, `*.sql`. */
    postgres: MigrationSource;
    /** Default: its `sqlite/` subfolder, `*.sqlite.sql`. */
    sqlite: MigrationSource;
  };
  /**
   * How messages refer to the CLI when they tell the user what to run next, e.g.
   * `npm run db:migrate --`. Default `db-manager migrate`. The hints use flag forms
   * (`--init`, `--baseline <prefix>`, `--dry-run`), which every command accepts.
   */
  command: string;
  /** Extra advice added to the "record what this database already has" hint, e.g. which prefix to use. */
  baselineHint?: string;
  /** Where pg_dump and psql are looked for. */
  pgTools: PgToolSettings;
}

/** {@link EngineSettings} with every part optional. */
export interface EngineSettingsInput {
  /** See {@link EngineSettings.schema}. */
  schema?: string;
  /** See {@link EngineSettings.ledger}. */
  ledger?: Partial<EngineSettings['ledger']>;
  /** See {@link EngineSettings.lockKey}. */
  lockKey?: number;
  /** See {@link EngineSettings.migrations}. */
  migrations?: {
    /** Postgres files. */
    postgres?: Partial<MigrationSource>;
    /** SQLite files. */
    sqlite?: Partial<MigrationSource>;
  };
  /** See {@link EngineSettings.command}. */
  command?: string;
  /** See {@link EngineSettings.baselineHint}. */
  baselineHint?: string;
  /** See {@link EngineSettings.pgTools}. */
  pgTools?: Partial<PgToolSettings>;
}

/** The defaults. They match the behaviour of the EasyFreight runner this package came from. */
export const DEFAULT_SETTINGS: EngineSettings = {
  schema: 'public',
  ledger: { table: 'schema_migrations', initFile: '000_create_schema_migrations' },
  lockKey: 4_172_207_311,
  migrations: {
    postgres: { folder: '.', suffix: '.sql' },
    sqlite: { folder: 'sqlite', suffix: '.sqlite.sql' },
  },
  command: 'db-manager migrate',
  pgTools: { extraDirs: [], homebrew: true },
};

/** Table and schema names go into SQL as they are, so they are held to plain identifiers. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Fills in the defaults and checks the result.
 *
 * @throws Error when the schema or ledger name is not a plain identifier, or the lock key is not an integer.
 */
export function engineSettings(input: EngineSettingsInput = {}): EngineSettings {
  const s: EngineSettings = {
    schema: input.schema ?? DEFAULT_SETTINGS.schema,
    ledger: { ...DEFAULT_SETTINGS.ledger, ...input.ledger },
    lockKey: input.lockKey ?? DEFAULT_SETTINGS.lockKey,
    migrations: {
      postgres: { ...DEFAULT_SETTINGS.migrations.postgres, ...input.migrations?.postgres },
      sqlite: { ...DEFAULT_SETTINGS.migrations.sqlite, ...input.migrations?.sqlite },
    },
    command: input.command ?? DEFAULT_SETTINGS.command,
    baselineHint: input.baselineHint,
    pgTools: { ...DEFAULT_SETTINGS.pgTools, ...input.pgTools },
  };
  if (!IDENTIFIER.test(s.schema)) throw new Error(`schema must be a plain identifier, got '${s.schema}'`);
  if (!IDENTIFIER.test(s.ledger.table)) throw new Error(`ledger.table must be a plain identifier, got '${s.ledger.table}'`);
  if (!Number.isSafeInteger(s.lockKey)) throw new Error(`lockKey must be an integer, got ${s.lockKey}`);
  for (const driver of ['postgres', 'sqlite'] as const) {
    if (!s.migrations[driver].suffix) throw new Error(`migrations.${driver}.suffix must not be empty`);
  }
  return s;
}
