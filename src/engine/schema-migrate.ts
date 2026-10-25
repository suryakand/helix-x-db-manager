import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import type { DataSource } from 'typeorm';
import { Db, Dialect, MigrateDriver, driverOf, sqlText } from './dialect';
import { engineSettings, EngineSettings, EngineSettingsInput, MigrationSource } from './settings';

/*
 * Applies numbered SQL files and keeps the record of them in a ledger table (`schema_migrations` by
 * default) in the same database.
 *
 * The ledger rules:
 *  - One row per file, written in the same transaction as the file: a file that fails leaves no
 *    row, and the run stops there.
 *  - Pending means "has no row", not "sorts after the newest row"; an out-of-order file is applied
 *    with a warning.
 *  - A row whose checksum is 'self-recorded' (a file may insert its own row, so that running it by
 *    hand still leaves one) was applied outside the runner. It is adopted -- given the real sha256 --
 *    and not re-run.
 *  - A new database -- no tables but the ledger, or none at all -- is built from the first file with
 *    no flags: the ledger is created from the driver's init file and every file runs, then the
 *    bootstrap step (if any) runs at the end.
 *  - Otherwise the ledger is created only when asked (init), and an empty ledger refuses to apply
 *    anything unless forced: a database that predates the ledger is brought in with a baseline first.
 *  - A baselined row (recorded, never run) whose file has since changed is not a changed migration --
 *    nothing ever ran -- so its checksum is just refreshed.
 *  - A file with its own BEGIN/COMMIT, or CONCURRENTLY, runs as written and is recorded once it succeeds.
 *
 * Each driver reads its own folder, and a version is the file name without its suffix, so the
 * two ledgers use the same names. By default:
 *   postgres  <dir>/NNN_name.sql
 *   sqlite    <dir>/sqlite/NNN_name.sqlite.sql   (not every number needs a twin)
 *
 * Postgres holds an advisory lock for the whole run, so two runs at once cannot apply a file twice.
 * SQLite is first copied to <file>.pre-migrate-<time> (VACUUM INTO) before anything is applied --
 * that copy is the undo, since migrations are forward-only.
 */

export type { MigrateDriver } from './dialect';

/** What {@link migrateSchema} does: apply pending files, report, record files without running them, or create the ledger. */
export type MigrateAction = 'apply' | 'status' | 'baseline' | 'init';

/**
 * A step that runs once, after the files, while the database still lacks something only a person
 * can supply -- typically the first administrator. The CLI collects the answers before the run and
 * hands the engine this object.
 */
export interface Bootstrap {
  /** What it creates, for messages: "first administrator". */
  label: string;
  /** Whether it is still needed. Asked before the run (so the CLI can prompt) and again before `run`. */
  needed(db: Db): Promise<boolean>;
  /**
   * Writes it, inside a transaction of its own. Returns a line to log. Left out when the answers were
   * not given: the run then says the step is still to do.
   */
  run?: (db: Db) => Promise<string | void>;
  /** Shown by a dry run, e.g. "would create administrator a@b.c". */
  summary?: string;
}

/** Options for {@link migrateSchema}. */
export interface MigrateOptions {
  /** What to do. */
  action: MigrateAction;
  /** The migrations directory; each driver's files are in its configured folder under it. */
  dir: string;
  /** Say what would happen; write nothing. */
  dryRun?: boolean;
  /** baseline: record every file up to the last one whose name starts with this. */
  baselinePrefix?: string;
  /** Apply even though the ledger has no rows. */
  force?: boolean;
  /** The ORM's synchronize is on, so the tables came from the entities: only warns. */
  synchronize?: boolean;
  /** The step run after the files. See {@link Bootstrap}. */
  bootstrap?: Bootstrap;
  /** Ledger, schema, lock and file-location settings. */
  settings?: EngineSettingsInput | EngineSettings;
  /** Progress lines. Default `console.log`. */
  log?: (line: string) => void;
  /** Warnings. Default `console.warn`. */
  warn?: (line: string) => void;
}

/** What {@link migrateSchema} did. */
export interface MigrateResult {
  /** Versions applied, in order. */
  applied: string[];
  /** The sqlite copy made before applying anything, or null. */
  backup: string | null;
}

/** One migration file. */
export interface MigrationFile {
  /** The file name without its suffix; what the ledger records. */
  version: string;
  /** The absolute path. */
  file: string;
}

const SELF_RECORDED = 'self-recorded';

/** The folder and suffix a driver's files live under. */
export function migrationSource(dir: string, driver: MigrateDriver, settings?: EngineSettingsInput | EngineSettings): MigrationSource {
  const source = engineSettings(settings).migrations[driver];
  return { folder: join(dir, source.folder), suffix: source.suffix };
}

/**
 * The driver's migration files, sorted by name.
 *
 * @throws Error when the folder is missing or has no files, or a name has characters other than letters, digits, `.`, `_` and `-`.
 */
export function migrationFiles(dir: string, driver: MigrateDriver, settings?: EngineSettingsInput | EngineSettings): MigrationFile[] {
  const { folder, suffix } = migrationSource(dir, driver, settings);
  if (!existsSync(folder)) {
    throw new Error(`no migrations folder at ${folder}. Set migrations.dir in the config, or pass --dir.`);
  }
  // When both drivers share a folder, `.sql` also matches `.sqlite.sql`: the longer suffix owns those files.
  const other = migrationSource(dir, driver === 'postgres' ? 'sqlite' : 'postgres', settings);
  const othersFile = (name: string): boolean =>
    other.folder === folder && other.suffix.length > suffix.length && name.endsWith(other.suffix);
  const files = readdirSync(folder)
    .filter((name) => name.endsWith(suffix) && !othersFile(name) && statSync(join(folder, name)).isFile())
    .sort()
    .map((name) => ({ version: basename(name, suffix), file: join(folder, name) }));
  for (const { version, file } of files) {
    // Versions are written into SQL literals below; hold them to what a file name looks like anyway.
    if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`unexpected migration file name: ${file}`);
  }
  if (files.length === 0) throw new Error(`no *${suffix} files in ${folder}`);
  return files;
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** CONCURRENTLY cannot run in a transaction block, and a file's own BEGIN/COMMIT would end ours early. */
const managesOwnTransactions = (sql: string): boolean =>
  /^\s*(begin|commit)(\s+transaction)?\s*;|^[^-\n]*concurrently/im.test(sql);

/**
 * Whether the bootstrap step still has to run. The CLI asks this before {@link migrateSchema}, so it
 * can prompt without holding the lock.
 */
export async function bootstrapNeeded(
  dataSource: DataSource,
  bootstrap: Pick<Bootstrap, 'needed'>,
  settings?: EngineSettingsInput | EngineSettings,
): Promise<boolean> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    return await bootstrap.needed(new Dialect(driverOf(dataSource), dataSource, runner, engineSettings(settings)));
  } finally {
    await runner.release();
  }
}

/** Applies, reports, baselines or initialises, as `options.action` says. */
export async function migrateSchema(dataSource: DataSource, options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const settings = engineSettings(options.settings);
  const driver = driverOf(dataSource);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const dialect = new Dialect(driver, dataSource, runner, settings);
  try {
    if (driver === 'postgres') await runner.query('SELECT pg_advisory_lock($1)', [settings.lockKey]);
    return await run(dialect, dataSource, options, log, warn);
  } finally {
    if (driver === 'postgres') await runner.query('SELECT pg_advisory_unlock($1)', [settings.lockKey]).catch(() => undefined);
    await runner.release();
  }
}

async function run(
  db: Dialect,
  dataSource: DataSource,
  options: MigrateOptions,
  log: (line: string) => void,
  warn: (line: string) => void,
): Promise<MigrateResult> {
  const s = db.settings;
  const cmd = s.command;
  const ledgerName = s.ledger.table;
  const result: MigrateResult = { applied: [], backup: null };
  const files = migrationFiles(options.dir, db.driver, s);
  const { folder } = migrationSource(options.dir, db.driver, s);

  const ledgerFile = files.find((f) => f.version === s.ledger.initFile);
  const fresh = !(await db.hasAppTables());
  const baselineHint = (): string[] => (s.baselineHint ? [`     ${s.baselineHint}`] : []);

  if (options.action === 'init') {
    if (!ledgerFile) throw new Error(`no ${s.ledger.initFile} file in ${folder}`);
    if (await db.ledgerExists()) {
      log(`${ledgerName} already exists; nothing to do`);
    } else if (options.dryRun) {
      log(`would create ${ledgerName} from ${ledgerFile.file}`);
    } else {
      await db.exec(readFileSync(ledgerFile.file, 'utf8'));
      log(`created ${ledgerName}`);
    }
    log('next: record what this database already has, then apply the rest:');
    log(`  ${cmd} --baseline <last file it has> --dry-run`);
    return result;
  }

  let ledgerExists = await db.ledgerExists();
  if (!ledgerExists && fresh && options.action === 'status') {
    log(`${folder}`);
    log(`empty database -- \`${cmd}\` will build it, starting from ${files[0].version}`);
    return result;
  }
  if (!ledgerExists && fresh && options.action === 'apply') {
    // A new database: create the ledger the way init does, then let the init file run and record
    // itself like any other file (it should be IF NOT EXISTS).
    if (!ledgerFile) throw new Error(`no ${s.ledger.initFile} file in ${folder}`);
    if (options.dryRun) {
      log(`would create ${ledgerName} from ${ledgerFile.file}`);
    } else {
      await db.exec(readFileSync(ledgerFile.file, 'utf8'));
      log(`new database: created ${ledgerName}; building it from ${files[0].version}`);
      ledgerExists = true;
    }
  }
  if (!ledgerExists && !(fresh && options.dryRun && options.action === 'apply')) {
    throw new Error(
      [
        `${ledgerName} does not exist in this database.`,
        `Every file applied is recorded in that table, and it is created only when asked.`,
        '',
        'To fix it:',
        '  1. Create the ledger (safe to re-run):',
        `       ${cmd} --init`,
        '  2. Record the files this database already has, without running them. The prefix is the',
        '     last one it has. Check the list first:',
        ...baselineHint(),
        `       ${cmd} --baseline <prefix> --dry-run`,
        `       ${cmd} --baseline <prefix>`,
        '  3. Apply the rest:',
        `       ${cmd} --dry-run`,
        `       ${cmd}`,
      ].join('\n'),
    );
  }

  const rows = ledgerExists
    ? await db.query<{ version: string; checksum: string; baselined: unknown }>(
        `SELECT version, checksum, baselined FROM ${db.ledger} ORDER BY version`,
      )
    : [];
  const ledger = new Map(rows.map((r) => [r.version, r.checksum]));
  const baselined = new Set(
    rows.filter((r) => r.baselined === true || Number(r.baselined) === 1).map((r) => r.version),
  );
  const who = `${userInfo().username}@${hostname().split('.')[0]}`.replace(/[^A-Za-z0-9._@-]/g, '');

  if (options.action === 'status') {
    log(`${folder}`);
    if (ledger.size === 0) log(`${ledgerName} has no rows -- nothing has been recorded yet`);
    for (const { version, file } of files) {
      const recorded = ledger.get(version);
      if (!recorded) log(`  pending   ${version}`);
      else if (recorded === SELF_RECORDED) log(`  self-rec  ${version}   (applied outside the runner; the next run adopts it)`);
      else if (recorded !== sha256(file) && baselined.has(version)) log(`  baseline  ${version}   (file changed since; never run here, so the next run refreshes its checksum)`);
      else if (recorded !== sha256(file)) log(`  CHANGED   ${version}   (edited after it was applied)`);
      else log(`  applied   ${version}`);
    }
    const known = new Set(files.map((f) => f.version));
    for (const version of ledger.keys()) {
      if (!known.has(version)) log(`  no file   ${version}   (recorded, but not in this folder)`);
    }
    if (ledger.size > 0) {
      log('detail:');
      const detail = await db.query<{ version: string; applied_at: unknown; applied_by: string | null; baselined: unknown }>(
        `SELECT version, applied_at, applied_by, baselined FROM ${db.ledger} ORDER BY version`,
      );
      for (const r of detail) {
        const at = new Date(r.applied_at as string).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
        const how = r.baselined === true || Number(r.baselined) === 1 ? 'baseline' : '';
        log(`  ${r.version}   ${at}   ${r.applied_by ?? ''}   ${how}`.trimEnd());
      }
    }
    if (options.bootstrap && (await options.bootstrap.needed(db))) log(`the next \`${cmd}\` will ask for the ${options.bootstrap.label}`);
    return result;
  }

  if (options.action === 'baseline') {
    const prefix = options.baselinePrefix ?? '';
    const last = files.filter((f) => basename(f.file).startsWith(prefix)).pop();
    if (!prefix || !last) throw new Error(`--baseline ${prefix} matches no file in ${folder}`);
    let n = 0;
    for (const { version, file } of files) {
      if (!ledger.has(version)) {
        if (options.dryRun) {
          log(`would mark ${version} as applied (baseline, not run)`);
        } else {
          await db.query(
            `INSERT INTO ${db.ledger} (version, checksum, applied_by, baselined)
             VALUES (${db.param(1)}, ${db.param(2)}, ${db.param(3)}, ${db.bool(true)})`,
            [version, sha256(file), who],
          );
          log(`marked ${version} as applied (baseline, not run)`);
        }
        n++;
      }
      if (file === last.file) break;
    }
    log(`baseline: ${n} file(s) ${options.dryRun ? 'would be ' : ''}recorded without running them`);
    return result;
  }

  if (options.synchronize) {
    warn('synchronize is on: TypeORM already built these tables from the entities. Consider --baseline instead of running the files.');
  } else if (ledger.size === 0 && !fresh && !options.force) {
    // A database with tables and an empty ledger already has what some of the files do. Running
    // from the top is never what was meant.
    throw new Error(
      [
        `${ledgerName} has no rows, so every file would count as pending -- including files`,
        'whose tables this database already has. Record what it already has first:',
        `  ${cmd} --baseline <last file it has> --dry-run`,
        ...(s.baselineHint ? [`  (${s.baselineHint})`] : []),
        'or pass --force to run everything regardless.',
      ].join('\n'),
    );
  }
  const newest = [...ledger.keys()].pop();

  const pending: MigrationFile[] = [];
  for (const f of files) {
    const recorded = ledger.get(f.version);
    if (recorded === SELF_RECORDED) {
      if (options.dryRun) {
        log(`would adopt ${f.version} (applied outside the runner; not re-run)`);
      } else {
        await db.query(
          `UPDATE ${db.ledger} SET checksum = ${db.param(1)} WHERE version = ${db.param(2)}`,
          [sha256(f.file), f.version],
        );
        log(`adopted ${f.version} (applied outside the runner; not re-run)`);
      }
    } else if (recorded) {
      const sum = sha256(f.file);
      if (recorded === sum) continue;
      if (baselined.has(f.version)) {
        // Recorded by a baseline, never run here: the old checksum describes nothing that happened.
        if (options.dryRun) {
          log(`would refresh the checksum of baselined ${f.version} (never run here; not re-run)`);
        } else {
          await db.query(
            `UPDATE ${db.ledger} SET checksum = ${db.param(1)} WHERE version = ${db.param(2)}`,
            [sum, f.version],
          );
          log(`refreshed the checksum of baselined ${f.version} (never run here; not re-run)`);
        }
      } else {
        warn(`${f.version} was edited after it was applied; not re-run. Put the change in a new file.`);
      }
    } else {
      pending.push(f);
    }
  }

  if (options.dryRun) {
    for (const { version } of pending) log(`would apply ${version}`);
    log(`dry run: ${pending.length} pending file(s)`);
    // On a database that does not exist yet the hook's tables are not there either: it is needed.
    if (options.bootstrap && (!ledgerExists || (await options.bootstrap.needed(db)))) {
      log(options.bootstrap.summary ?? `would create the ${options.bootstrap.label} (asked for when this runs for real)`);
    }
    return result;
  }
  if (pending.length === 0) {
    log('nothing pending');
    await runBootstrap(db, options.bootstrap, log);
    return result;
  }

  // A new database has nothing worth a copy.
  if (db.driver === 'sqlite' && !fresh) result.backup = await backupSqlite(db, dataSource, log);

  for (const { version, file } of pending) {
    if (newest && version < newest) warn(`${version} sorts before ${newest}, which is already applied -- applying it out of order`);
    const sql = readFileSync(file, 'utf8');
    const sum = sha256(file);
    const own = managesOwnTransactions(sql);
    log(`applying ${version}${own ? ' (its own transactions)' : ''}`);
    try {
      if (own) {
        await db.exec(sql);
        await db.exec(db.recordSql(version, sum, who));
      } else {
        await db.exec(`BEGIN;\n${sql}\n;\n${db.recordSql(version, sum, who)}\nCOMMIT;`);
      }
    } catch (error) {
      await db.exec('ROLLBACK;').catch(() => undefined);
      throw new Error(
        `${version} failed${own ? '' : ' and was rolled back'}; it is not recorded.\n` +
          `${(error as Error).message}\n` +
          `The database is at the last file that completed${result.backup ? ` (backup: ${result.backup})` : ''}. Fix it and run \`${cmd}\` again.`,
      );
    }
    result.applied.push(version);
  }
  log(`applied ${result.applied.length} file(s)`);
  await runBootstrap(db, options.bootstrap, log);
  return result;
}

/**
 * The bootstrap step, in a transaction of its own. Only while it is still needed, so a re-run -- or a
 * database someone else just populated -- never gets it twice.
 */
async function runBootstrap(db: Dialect, bootstrap: Bootstrap | undefined, log: (line: string) => void): Promise<void> {
  if (!bootstrap || !(await bootstrap.needed(db))) return;
  if (!bootstrap.run) {
    log(`the ${bootstrap.label} was not given; run \`${db.settings.command}\` again to create it`);
    return;
  }
  await db.query('BEGIN');
  let line: string | void;
  try {
    line = await bootstrap.run(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw new Error(`creating the ${bootstrap.label} failed: ${(error as Error).message}`);
  }
  log(line || `created the ${bootstrap.label}`);
}

async function backupSqlite(db: Dialect, dataSource: DataSource, log: (line: string) => void): Promise<string | null> {
  const file = String(dataSource.options.database ?? '');
  if (!file || file === ':memory:' || !existsSync(file) || statSync(file).size === 0) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const target = `${file}.pre-migrate-${stamp}`;
  await db.query(`VACUUM INTO ${sqlText(target)}`);
  log(`backup written to ${target}`);
  return target;
}
