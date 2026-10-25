import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DataSource } from 'typeorm';
import { databaseName, openDataSource, resolveConnection, targetLabel } from '../config/connection';
import { loadEnvFiles } from '../config/env';
import { loadConfig } from '../config/load-config';
import type { Env } from '../config/types';
import { exportDatabase } from '../engine/db-export';
import { assertPlainSql, importDatabase } from '../engine/db-import';
import { Bootstrap, bootstrapNeeded, migrateSchema } from '../engine/schema-migrate';
import { engineSettings } from '../engine/settings';
import { CliError, type CliOptions, parseArgs, USAGE } from './args';
import { printBanner, shortPath } from './banner';
import { paint, paintLine } from './colors';
import { chooseFromMenu } from './menu';
import { askText, askYesNo, bootstrapAnswers, cleanPath, confirmImport, interactive } from './prompts';

/*
 * The command: reads the config, works out which database and folders it means, shows them, asks
 * what it must, and hands the work to the engine (schema-migrate.ts, db-export.ts, db-import.ts).
 *
 * The env files fill in only what the environment does not already set, so in a container the real
 * environment wins and a missing .env is normal; the banner says where each database value came
 * from.
 */

const log = (line: string): void => console.log(`${paint('==>', 'dim')} ${paintLine(line)}`);
const warn = (line: string): void => console.warn(paint(`WARN: ${line}`, 'yellow', process.stderr));

/** The words the banner uses for an action. */
function describeAction(opts: CliOptions, exportDir: string): string {
  const action =
    opts.action === 'menu' ? '(chosen below)'
    : opts.action === 'status' ? 'status (read only)'
    : opts.action === 'baseline' ? `baseline up to ${opts.baselinePrefix}`
    : opts.action === 'init' ? 'init (create the ledger)'
    : opts.action === 'export' ? `export to ${shortPath(exportDir)}${opts.columnInserts ? ' (column-list INSERTs)' : ''}`
    : opts.action === 'import' ? `import ${opts.importFile ? shortPath(resolve(process.cwd(), opts.importFile)) : '(file asked for below)'}`
    : 'apply';
  return `${action}${opts.dryRun && opts.action !== 'status' ? ' -- dry run' : ''}`;
}

/** The package's version, for --version. */
export type VersionReader = () => string;

/**
 * Runs the command line and resolves when it is done.
 *
 * @throws CliError for a refusal; any other Error for a failure.
 */
export async function runCli(argv: string[], readVersion: VersionReader): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }

  const loaded = await loadConfig(process.cwd(), opts.config ?? undefined).catch((error: Error) => {
    throw new CliError(error.message);
  });
  const { config, rootDir } = loaded;

  // --env-file is relative to where the command runs; the configured files to the root.
  const envFiles = opts.envFile
    ? [resolve(process.cwd(), opts.envFile)]
    : config.envFile === false ? [] : [config.envFile ?? '.env'].flat().map((f) => resolve(rootDir, f));
  let loadedEnv;
  try {
    loadedEnv = loadEnvFiles(envFiles, opts.envFile ? envFiles : []);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
  const env: Env = process.env;

  const pick = (name: string | false | undefined, fallback: string): string | undefined =>
    name === false ? undefined : env[name ?? fallback] || undefined;
  const settings = engineSettings({
    schema: config.schema,
    ledger: config.ledger,
    lockKey: config.lockKey,
    migrations: { postgres: config.migrations?.postgres, sqlite: config.migrations?.sqlite },
    command: config.command,
    baselineHint: config.baselineHint,
    pgTools: {
      binDir: config.pgTools?.binDir ?? pick(config.pgTools?.binDirEnv, 'PG_BIN_DIR'),
      extraDirs: config.pgTools?.extraDirs ?? [],
      homebrew: config.pgTools?.homebrew ?? true,
    },
  });

  let connection;
  try {
    connection = resolveConnection(config, rootDir, env);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
  const { spec } = connection;
  const migrationsFromEnv = pick(config.migrations?.dirEnv, 'MIGRATIONS_DIR');
  const migrationsDir = opts.dir
    ? resolve(process.cwd(), opts.dir)
    : migrationsFromEnv ? resolve(process.cwd(), migrationsFromEnv) : resolve(rootDir, config.migrations?.dir ?? 'database/migrations');
  const exportFromEnv = pick(config.export?.dirEnv, 'DATABASE_EXPORT_DIR');
  const exportDirOf = (): string =>
    opts.out ? resolve(process.cwd(), opts.out)
    : exportFromEnv ? resolve(rootDir, exportFromEnv) : resolve(rootDir, config.export?.dir ?? 'database/exports');

  printBanner({
    config, configFile: loaded.file, env, loadedEnv, connection, migrationsDir,
    action: describeAction(opts, exportDirOf()),
    creates: opts.action === 'apply' || opts.action === 'import' || opts.action === 'menu',
  });

  if (opts.action === 'menu') {
    if (!interactive()) throw new CliError(`no command given, and there is no terminal to show the menu on.\n\n${USAGE}`);
    const go = await chooseFromMenu(opts, { spec, migrationsDir, exportDir: exportDirOf(), settings });
    if (!go) return;
    console.log(`\n  Action  ${describeAction(opts, exportDirOf())}\n`);
  }

  const target = targetLabel(spec);
  let createdSqlite = false;
  if (spec.type === 'sqlite' && !existsSync(spec.file)) {
    // TypeORM creates a missing file on connect. That is what a new database needs, but only when
    // it is about to be built; anywhere else a missing file is a wrong path.
    if (opts.action === 'apply' && opts.dryRun) {
      log(`${spec.file} does not exist; migrate would create it and build it from the first file`);
      return;
    }
    if (!['init', 'apply', 'import'].includes(opts.action)) throw new CliError(`no sqlite database at ${spec.file}`);
    if (!existsSync(dirname(spec.file))) throw new CliError(`no folder for the sqlite database at ${dirname(spec.file)}`);
    createdSqlite = true;
  }

  let importFile = '';
  if (opts.action === 'import') {
    let given = opts.importFile;
    if (!given) {
      if (!interactive()) throw new CliError('import needs the dump file when there is no terminal to ask on: import <file>');
      given = cleanPath(await askText('Dump file path:'));
      if (!given) throw new CliError('no file given; nothing was changed');
    }
    importFile = resolve(process.cwd(), cleanPath(given));
    try {
      assertPlainSql(importFile);
    } catch (error) {
      throw new CliError((error as Error).message);
    }
  }

  // Export only reads; import asks its own question once it knows what it would delete.
  const writes = !['status', 'export', 'import'].includes(opts.action) && !opts.dryRun;
  if (opts.action === 'import' && !opts.dryRun && !opts.yes && !interactive()) {
    throw new CliError('not on a terminal, so cannot ask for confirmation. Pass --yes to proceed.');
  }
  if (writes && !opts.yes) {
    if (!interactive()) throw new CliError('not on a terminal, so cannot ask for confirmation. Pass --yes to proceed.');
    if (!(await askYesNo(`Run against ${target}?`))) {
      log('cancelled; nothing was changed');
      return;
    }
  }

  let dataSource: DataSource;
  try {
    dataSource = await openDataSource(spec);
  } catch (error) {
    const e = error as Error & { code?: string };
    throw new CliError(`cannot connect to ${target}: ${e.message || e.code || String(e)}`);
  }
  try {
    if (opts.action === 'export') {
      await exportDatabase(dataSource, {
        dir: exportDirOf(), name: databaseName(spec), fileName: config.export?.fileName, fileMode: config.export?.fileMode,
        columnInserts: opts.columnInserts, settings, log,
      });
      return;
    }
    if (opts.action === 'import') {
      const name = databaseName(spec);
      const { plan } = await importDatabase(dataSource, {
        file: importFile,
        dryRun: opts.dryRun,
        confirm: opts.yes ? undefined : (p) => confirmImport(p, name, target, config.import?.confirm ?? 'name'),
        settings,
        log,
        warn,
      });
      // A script running a dry run as a gate needs the exit code, not just the report.
      if (plan.errors.length) throw new CliError('the dump is not compatible with this database (INCOMPATIBLE lines above); nothing was imported');
      return;
    }

    let bootstrap: Bootstrap | undefined;
    const hook = config.bootstrap;
    if (hook) {
      bootstrap = { label: hook.label, needed: hook.needed };
      // Asked before migrateSchema takes its lock, and before anything is written.
      if (opts.action === 'apply' && !opts.dryRun && (await bootstrapNeeded(dataSource, hook, settings))) {
        const answers = await bootstrapAnswers(hook, env);
        bootstrap.run = (db) => hook.run(db, answers);
      } else if (opts.action === 'apply' && opts.dryRun && hook.questions.every((q) => q.env && env[q.env]) && hook.describe) {
        bootstrap.summary = hook.describe(Object.fromEntries(hook.questions.map((q) => [q.name, env[q.env!]!])));
      }
    }
    // The menu has replaced 'menu' by now; this tells the compiler so.
    if (opts.action === 'menu') return;
    await migrateSchema(dataSource, {
      action: opts.action,
      dir: migrationsDir,
      dryRun: opts.dryRun,
      baselinePrefix: opts.baselinePrefix,
      force: opts.force,
      synchronize: spec.synchronize,
      bootstrap,
      settings,
      log,
      warn,
    });
  } finally {
    await dataSource.destroy();
    // A dry run (or a cancelled import) must not leave behind the empty file connecting created.
    if (createdSqlite && spec.type === 'sqlite' && opts.action === 'import' && existsSync(spec.file) && statSync(spec.file).size === 0) {
      rmSync(spec.file);
    }
  }
}
