import { closeSync, createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DataSource, QueryRunner } from 'typeorm';
import { pgConnectionOf, pgServerMajor } from './db-export';
import { Dialect, driverOf, MigrateDriver, sqlText } from './dialect';
import { findPgTool, runPgTool } from './pg-tools';
import { engineSettings, EngineSettings, EngineSettingsInput } from './settings';

/*
 * import -- load a plain SQL dump into the database, replacing what is there.
 *
 *   postgres  a pg_dump plain-format file (export writes one). Loaded by psql.
 *   sqlite    a plain SQL file: export's, or a stock `sqlite3 <file> .dump`. Loaded here.
 *
 * Two cases, decided by the target:
 *
 *   empty     (no tables but the ledger) the whole dump runs: schema, data, indexes, constraints.
 *   has a     the dump's schema is skipped and only its data goes in. First the dump's tables are
 *   schema    checked against the target's: a table or column the target lacks, or a NOT NULL
 *             target column with no default that the dump does not fill, stops the import. Then,
 *             in one transaction, the dump's tables are emptied and reloaded -- REPLACE, not merge --
 *             and the target's own foreign keys are checked against the loaded rows.
 *
 * Everything runs in one transaction. A failure leaves the target exactly as it was. A dry run does
 * all of it, then rolls back, so "compatible" means the data really loaded under the target's
 * constraints, not just that the column names line up. There is no backup step: export first if the
 * target's data matters.
 *
 * Only plain SQL is accepted. Compressed files, archives and pg_dump's custom/tar formats are refused.
 */

/** One table of an {@link ImportPlan}. */
export interface ImportTable {
  /** `schema.table` on postgres, the table on sqlite. */
  name: string;
  /** Rows in the dump. */
  rows: number;
  /** Rows the target holds now; they are deleted. */
  targetRows: number;
}

/** What an import found and will do, worked out before anything is written. */
export interface ImportPlan {
  /** Which database the target is. */
  driver: MigrateDriver;
  /** `empty`: the whole dump runs. `replace`: the dump's tables are emptied and reloaded, its schema skipped. */
  mode: 'empty' | 'replace';
  /** Every table the dump fills. */
  tables: ImportTable[];
  /** Incompatibilities: any one stops the import. */
  errors: string[];
  /** Differences that do not stop it. */
  warnings: string[];
  /** The newest ledger version in the dump. */
  dumpVersion: string | null;
  /** The newest ledger version in the target. */
  targetVersion: string | null;
}

/** Options for {@link importDatabase}. */
export interface ImportOptions {
  /** The plain SQL dump. */
  file: string;
  /** Check and load inside a transaction, then roll back. */
  dryRun?: boolean;
  /** Asked once the checks pass, before a real import writes; false cancels. Never asked on a dry run. */
  confirm?: (plan: ImportPlan) => Promise<boolean>;
  /** Ledger, schema, lock and pg tool settings. */
  settings?: EngineSettingsInput | EngineSettings;
  /** Progress lines. Default `console.log`. */
  log?: (line: string) => void;
  /** Warnings and incompatibilities. Default `console.warn`. */
  warn?: (line: string) => void;
}

/** What {@link importDatabase} did. */
export interface ImportResult {
  /** What was found. */
  plan: ImportPlan;
  /** False when the plan had errors, the user cancelled, or it was a dry run. */
  committed: boolean;
}

/**
 * Refuses anything that is not plain SQL text, naming what it found.
 *
 * @throws Error for a missing file, a compressed file, an archive or binary data.
 */
export function assertPlainSql(file: string): void {
  if (!existsSync(file)) throw new Error(`no file at ${file}`);
  if (!statSync(file).isFile()) throw new Error(`${file} is not a file`);
  const head = Buffer.alloc(512);
  const fd = openSync(file, 'r');
  const n = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  const b = head.subarray(0, n);
  const found =
    b[0] === 0x1f && b[1] === 0x8b ? 'a gzip file'
    : b.subarray(0, 4).toString('latin1') === 'PK\x03\x04' ? 'a zip file'
    : b.subarray(0, 5).toString('latin1') === 'PGDMP' ? "a pg_dump custom-format archive (use pg_dump --format=plain)"
    : b.subarray(257, 262).toString('latin1') === 'ustar' ? 'a tar archive'
    : b.subarray(0, 3).toString('latin1') === 'BZh' ? 'a bzip2 file'
    : b.includes(0) ? 'binary data'
    : null;
  if (found) throw new Error(`${file} is ${found}; import takes a plain SQL file only`);
}

/** Loads a plain SQL dump into the database, replacing its data. One transaction; see the top of this file. */
export async function importDatabase(dataSource: DataSource, options: ImportOptions): Promise<ImportResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  assertPlainSql(options.file);
  const driver = driverOf(dataSource);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const db = new Dialect(driver, dataSource, runner, engineSettings(options.settings));
    return driver === 'postgres'
      ? await importPostgres(dataSource, runner, db, options, log, warn)
      : await importSqlite(runner, db, options, log, warn);
  } finally {
    await runner.release();
  }
}

// ---------------------------------------------------------------- shared

interface TargetColumn {
  name: string;
  type: string;
  /** NOT NULL with nothing to fill it: no default, not identity/generated (postgres), not the rowid alias (sqlite). */
  required: boolean;
}

/**
 * The comparison both drivers share. `dumpColumns` is null when the dump does not say which columns
 * a table's rows fill (a sqlite INSERT without a column list) -- then only the count can be checked.
 */
function compareTable(
  table: string,
  dumpColumns: string[] | null,
  target: TargetColumn[] | undefined,
  plan: ImportPlan,
  dumpWidth?: number,
): void {
  if (!target) {
    plan.errors.push(`table ${table} is in the dump but not in this database`);
    return;
  }
  if (dumpColumns === null) {
    if (dumpWidth !== undefined && dumpWidth !== target.length) {
      plan.errors.push(`${table}: the dump's INSERTs have no column list and ${dumpWidth} value(s); the table here has ${target.length} column(s)`);
    }
    return;
  }
  const have = new Set(target.map((c) => c.name));
  const missing = dumpColumns.filter((c) => !have.has(c));
  if (missing.length) plan.errors.push(`${table}: column(s) ${missing.join(', ')} are in the dump but not in this database`);
  const filled = new Set(dumpColumns);
  for (const c of target.filter((x) => !filled.has(x.name))) {
    if (c.required) plan.errors.push(`${table}.${c.name} is NOT NULL with no default here, and the dump has no value for it`);
    else plan.warnings.push(`${table}.${c.name} is not in the dump; it gets its default (or NULL)`);
  }
}

function printPlan(plan: ImportPlan, file: string, dryRun: boolean, s: EngineSettings, log: (line: string) => void, warn: (line: string) => void): void {
  log(`${file}`);
  log(plan.mode === 'empty'
    ? 'this database is empty: the whole dump runs -- schema, data, indexes, constraints'
    : "this database has a schema: the dump's schema is skipped, its tables are emptied and reloaded");
  log(`dump schema version ${plan.dumpVersion ?? '(none recorded)'}; this database ${plan.targetVersion ?? '(none recorded)'}`);
  if (plan.mode === 'replace' && plan.dumpVersion !== plan.targetVersion) {
    plan.warnings.push(
      `the dump was taken at schema ${plan.dumpVersion ?? '(unknown)'}, this database is at ${plan.targetVersion ?? '(unknown)'}; ` +
        `it keeps its own schema and ${s.ledger.table} -- run \`${s.command}\` afterwards if it is behind`,
    );
  }
  const width = Math.max(5, ...plan.tables.map((t) => t.name.length));
  log(`  ${'table'.padEnd(width)}  ${'dump rows'.padStart(9)}  ${plan.mode === 'replace' ? 'rows here (deleted)' : ''}`.trimEnd());
  for (const t of plan.tables) {
    log(`  ${t.name.padEnd(width)}  ${String(t.rows).padStart(9)}  ${plan.mode === 'replace' ? String(t.targetRows).padStart(9) : ''}`.trimEnd());
  }
  for (const w of plan.warnings) warn(w);
  for (const e of plan.errors) warn(`INCOMPATIBLE: ${e}`);
  if (plan.errors.length) log(`${plan.errors.length} incompatibilit${plan.errors.length === 1 ? 'y' : 'ies'}: nothing was imported`);
  else if (dryRun) log('checks passed; now loading it inside a transaction that is rolled back (as long as a real import)');
}

/** Ask before writing anything (the caller shows the rows that will be deleted); never on a dry run. */
async function confirmed(plan: ImportPlan, options: ImportOptions, log: (line: string) => void): Promise<boolean> {
  if (options.dryRun || !options.confirm) return true;
  if (await options.confirm(plan)) return true;
  log('cancelled; nothing was changed');
  return false;
}

// ---------------------------------------------------------------- postgres

interface PgTable {
  schema: string;
  table: string;
  /** null for `pg_dump --inserts` without --column-inserts: the rows say how many values, not which columns. */
  columns: string[] | null;
  /** Values per row, for a table whose INSERTs have no column list. */
  width?: number;
  rows: number;
}

interface PgScan {
  /** Keyed by schema.table, as information_schema spells it. */
  tables: Map<string, PgTable>;
  createsLedger: boolean;
  dumpVersion: string | null;
  dropped: string[];
  /** `ALTER ... OWNER TO` statements left out: the importing user owns what the dump creates. */
  owners: number;
}


/** `COPY public.bookings (id, "createdDate", ...) FROM stdin;` */
const COPY_LINE = /^COPY ((?:"(?:[^"]|"")+"|[\w$]+)\.(?:"(?:[^"]|"")+"|[\w$]+)) \((.*)\) FROM stdin;$/;

const unquote = (ident: string): string => (ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident);

function splitIdents(list: string): string[] {
  const out: string[] = [];
  const re = /\s*("(?:[^"]|"")+"|[^,]+)\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list)) && m[0]) out.push(unquote(m[1].trim()));
  return out;
}

/** schema.table with both parts unquoted, as information_schema names them. */
function qualified(name: string): { schema: string; table: string } {
  const m = /^("(?:[^"]|"")+"|[\w$]+)\.("(?:[^"]|"")+"|[\w$]+)$/.exec(name);
  if (!m) throw new Error(`cannot read the table name ${name}`);
  return { schema: unquote(m[1]), table: unquote(m[2]) };
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** "schema"."table", safe to put in SQL. */
const quotedName = (t: PgTable): string => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;

function writeLine(out: WriteStream, line: string): Promise<void> {
  if (out.write(`${line}\n`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Both listeners go once either fires: left behind, one per backed-up write, they pile up.
    const done = (err?: Error): void => {
      out.off('drain', done);
      out.off('error', done);
      if (err) reject(err);
      else resolve();
    };
    out.on('drain', done).on('error', done);
  });
}

/**
 * `INSERT INTO public.bookings (id, ...) VALUES (...)`, from pg_dump --inserts / --column-inserts. A
 * table with a GENERATED ALWAYS identity column gets `OVERRIDING SYSTEM VALUE` before VALUES.
 */
const INSERT_HEAD = /^INSERT INTO ((?:"(?:[^"]|"")+"|[\w$]+)\.(?:"(?:[^"]|"")+"|[\w$]+))(?: \((.*?)\))?(?: OVERRIDING SYSTEM VALUE)? VALUES /;

/** Odd: the text leaves a '...' literal open. pg_dump writes '' for a quote (standard_conforming_strings). */
const opensString = (text: string): boolean => (text.split("'").length - 1) % 2 === 1;

/**
 * Rows in one INSERT (several with --rows-per-insert) and the values in its first row: the tuples at
 * the top level after VALUES, with quotes skipped.
 */
function insertShape(sql: string): { rows: number; width: number } {
  let i = sql.search(/ VALUES /) + 8;
  let depth = 0;
  let rows = 0;
  let width = 1;
  let inString = false;
  for (; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = sql[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') { if (depth++ === 0) rows++; }
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 1 && rows === 1) width++;
  }
  return { rows, width };
}

/**
 * One pass over the dump. Writes two copies: `full` (the dump minus SET lines this server cannot take:
 * pg_dump 17+ writes `SET transaction_timeout`, which 15 and 16 reject) and `data` (only what loads
 * rows into an existing schema: the session SETs, the COPY blocks, setval, and psql's \restrict pair).
 */
/**
 * `keepLedger` false (an existing schema): the dump's schema_migrations rows are read for its version but
 * left out of `data` -- the target keeps its own schema, so it must keep the ledger that describes it.
 */
async function scanPgDump(file: string, known: Set<string>, full: string, data: string, keepLedger: boolean, s: EngineSettings): Promise<PgScan> {
  // The ledger describes a schema, so it travels with the dump's schema and never alone.
  const ledgerTable = `${s.schema}.${s.ledger.table}`;
  const createsLedger = new RegExp(`^CREATE TABLE (${s.schema}\\.)?"?${s.ledger.table}"? `);
  const scan: PgScan = { tables: new Map(), createsLedger: false, dumpVersion: null, dropped: [], owners: 0 };
  const fullOut = createWriteStream(full);
  const dataOut = createWriteStream(data);
  let copy: { name: string; rows: number; ledger: boolean; skip: boolean } | null = null;
  // An INSERT whose text has a newline in a value continues on the next lines.
  let insert: string[] | null = null;
  let insertOpen = false;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const finishInsert = async (): Promise<void> => {
    const sql = insert!.join('\n');
    insert = null;
    const m = INSERT_HEAD.exec(sql)!;
    const { schema, table } = qualified(m[1]);
    const name = `${schema}.${table}`;
    const ledger = name === ledgerTable;
    if (ledger) {
      const version = / VALUES \('((?:[^']|'')*)'/.exec(sql)?.[1];
      if (version && (!scan.dumpVersion || version > scan.dumpVersion)) scan.dumpVersion = version;
    }
    await writeLine(fullOut, sql);
    if (ledger && !keepLedger) return;
    const shape = insertShape(sql);
    const t = scan.tables.get(name) ?? { schema, table, columns: m[2] ? splitIdents(m[2]) : null, width: shape.width, rows: 0 };
    t.rows += shape.rows;
    scan.tables.set(name, t);
    await writeLine(dataOut, sql);
  };
  for await (const line of lines) {
    if (insert) {
      insert.push(line);
      if (opensString(line)) insertOpen = !insertOpen;
      if (!insertOpen) await finishInsert();
      continue;
    }
    if (!copy && INSERT_HEAD.test(line)) {
      insert = [line];
      insertOpen = opensString(line);
      if (!insertOpen) await finishInsert();
      continue;
    }
    if (copy) {
      const skip = copy.skip;
      if (line === '\\.') {
        if (!skip) scan.tables.get(copy.name)!.rows = copy.rows;
        copy = null;
      } else {
        copy.rows++;
        if (copy.ledger) {
          const version = line.split('\t')[0];
          if (!scan.dumpVersion || version > scan.dumpVersion) scan.dumpVersion = version;
        }
      }
      await writeLine(fullOut, line);
      if (!skip) await writeLine(dataOut, line);
      continue;
    }
    const set = /^SET (\w+) = /.exec(line);
    if (set && !known.has(set[1].toLowerCase())) {
      scan.dropped.push(set[1]);
      continue;
    }
    // A dump taken without --no-owner hands every object to its roles, which the target may not have.
    if (/^ALTER [A-Z ]+ .+ OWNER TO .+;$/.test(line)) {
      scan.owners++;
      continue;
    }
    // A dump of a database whose public schema was changed creates it, and a new database has it already.
    await writeLine(fullOut, line.replace(/^CREATE SCHEMA (?!IF NOT EXISTS )/, 'CREATE SCHEMA IF NOT EXISTS '));
    const m = COPY_LINE.exec(line);
    if (m) {
      const { schema, table } = qualified(m[1]);
      const name = `${schema}.${table}`;
      const ledger = name === ledgerTable;
      copy = { name, rows: 0, ledger, skip: ledger && !keepLedger };
      if (!copy.skip) {
        scan.tables.set(name, { schema, table, columns: splitIdents(m[2]), rows: 0 });
        await writeLine(dataOut, line);
      }
    } else if (set || /^SELECT pg_catalog\.(set_config|setval)\(/.test(line) || /^\\(un)?restrict /.test(line)) {
      await writeLine(dataOut, line);
    }
    if (createsLedger.test(line)) scan.createsLedger = true;
  }
  await Promise.all([fullOut, dataOut].map((o) => new Promise<void>((resolve) => o.end(resolve))));
  if (copy) throw new Error(`${file} ends inside the COPY block of ${copy.name}: the dump is truncated`);
  if (insert) throw new Error(`${file} ends inside an INSERT: the dump is truncated`);
  return scan;
}

async function importPostgres(
  dataSource: DataSource,
  runner: QueryRunner,
  db: Dialect,
  options: ImportOptions,
  log: (line: string) => void,
  warn: (line: string) => void,
): Promise<ImportResult> {
  const s = db.settings;
  const psql = findPgTool('psql', s.pgTools);
  const work = mkdtempSync(join(tmpdir(), 'db-manager-import-'));
  try {
    const known = new Set<string>((await runner.query('SELECT name FROM pg_settings')).map((r: { name: string }) => r.name));
    const fullFile = join(work, 'full.sql');
    const dataFile = join(work, 'data.sql');
    const mode = (await db.hasAppTables()) ? 'replace' : 'empty';
    const scan = await scanPgDump(options.file, known, fullFile, dataFile, mode === 'empty', s);
    if (scan.tables.size === 0) throw new Error(`${options.file} has no data (no COPY blocks, no INSERTs): it is not a pg_dump plain-format dump`);
    if (scan.owners) log(`skipping ${scan.owners} OWNER TO statement(s): what the dump creates belongs to ${pgConnectionOf(dataSource).user}`);
    if (scan.dropped.length) {
      log(`skipping SET ${[...new Set(scan.dropped)].join(', ')}: this server (${await pgServerMajor(runner)}) does not have ${scan.dropped.length === 1 ? 'that setting' : 'those settings'}`);
    }

    const plan: ImportPlan = {
      driver: 'postgres', mode, tables: [], errors: [], warnings: [], dumpVersion: scan.dumpVersion,
      targetVersion: await db.ledgerVersion(),
    };

    const targetColumns = new Map<string, TargetColumn[]>();
    if (mode === 'replace') {
      const cols: Array<{ t: string; name: string; type: string; nullable: string; def: string | null; ident: string; gen: string }> =
        await runner.query(
          `SELECT table_schema || '.' || table_name AS t, column_name AS name, data_type AS type,
                  is_nullable AS nullable, column_default AS def, is_identity AS ident, is_generated AS gen
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t, ordinal_position`,
        );
      for (const c of cols) {
        const list = targetColumns.get(c.t) ?? [];
        list.push({ name: c.name, type: c.type, required: c.nullable === 'NO' && c.def === null && c.ident !== 'YES' && c.gen !== 'ALWAYS' });
        targetColumns.set(c.t, list);
      }
      const baseTables: Array<{ t: string }> = await runner.query(
        "SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
        [s.schema],
      );
      for (const { t } of baseTables) if (!scan.tables.has(t) && t !== `${s.schema}.${s.ledger.table}`) plan.warnings.push(`table ${t} is not in the dump; it is left as it is`);
    }
    for (const [name, t] of scan.tables) {
      let targetRows = 0;
      if (mode === 'replace') {
        compareTable(name, t.columns, targetColumns.get(name), plan, t.columns ? undefined : t.width);
        if (targetColumns.has(name)) {
          targetRows = Number((await runner.query(`SELECT count(*) AS n FROM ${quotedName(t)}`))[0].n);
        }
      }
      plan.tables.push({ name, rows: t.rows, targetRows });
    }
    printPlan(plan, options.file, !!options.dryRun, db.settings, log, warn);
    if (plan.errors.length) return { plan, committed: false };
    if (!(await confirmed(plan, options, log))) return { plan, committed: false };

    const end = options.dryRun ? 'ROLLBACK;' : 'COMMIT;';
    const wrapper: string[] = ['\\set ON_ERROR_STOP 1', 'BEGIN;', `SELECT pg_advisory_xact_lock(${s.lockKey});`];
    if (mode === 'empty') {
      // A database `init` touched has the ledger already; the dump brings its own.
      if (scan.createsLedger && (await db.ledgerExists())) wrapper.push(`DROP TABLE ${db.ledger};`);
      wrapper.push(`\\i ${sqlText(fullFile)}`);
    } else {
      const tables = [...scan.tables.values()];
      const regclasses = tables.map((t) => sqlText(quotedName(t))).join(', ');
      wrapper.push(
        // The dump empties search_path, so names captured now must survive that: with it empty here
        // too, regclass::text and pg_get_constraintdef print every table schema-qualified.
        "SET LOCAL search_path = '';",
        // Every foreign key on or to the dump's tables: dropped so TRUNCATE and the COPYs can run in any
        // order (bookings and booking_jobs reference each other), re-added after, which checks every row.
        `CREATE TEMP TABLE db_manager_import_fks ON COMMIT DROP AS
           SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE contype = 'f'
              AND (conrelid = ANY (ARRAY[${regclasses}]::regclass[]) OR confrelid = ANY (ARRAY[${regclasses}]::regclass[]));`,
        `DO $$ DECLARE r record; BEGIN
           FOR r IN SELECT * FROM db_manager_import_fks LOOP
             EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
           END LOOP;
         END $$;`,
        `TRUNCATE TABLE ${tables.map(quotedName).join(', ')};`,
        // The target's own triggers must not fire on rows that are being restored, not written. Only
        // the enabled ones are switched off, and exactly those are switched back on.
        `CREATE TEMP TABLE db_manager_import_triggers ON COMMIT DROP AS
           SELECT tgrelid::regclass::text AS tbl, tgname
             FROM pg_trigger
            WHERE NOT tgisinternal AND tgenabled <> 'D' AND tgrelid = ANY (ARRAY[${regclasses}]::regclass[]);`,
        `DO $$ DECLARE r record; BEGIN
           FOR r IN SELECT * FROM db_manager_import_triggers LOOP
             EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.tbl, r.tgname);
           END LOOP;
         END $$;`,
        `\\i ${sqlText(dataFile)}`,
        `DO $$ DECLARE r record; BEGIN
           FOR r IN SELECT * FROM db_manager_import_triggers LOOP
             EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', r.tbl, r.tgname);
           END LOOP;
           FOR r IN SELECT * FROM db_manager_import_fks LOOP
             EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, r.def);
           END LOOP;
         END $$;`,
      );
    }
    wrapper.push(end);
    const wrapperFile = join(work, 'import.sql');
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(wrapperFile);
      out.on('error', reject);
      out.end(`${wrapper.join('\n')}\n`, resolve);
    });

    log(`${options.dryRun ? 'dry run: loading' : 'loading'} with psql (${psql})`);
    try {
      await runPgTool(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', wrapperFile], pgConnectionOf(dataSource));
    } catch (error) {
      throw new Error(`the import failed and was rolled back; this database is unchanged.\n${(error as Error).message}`);
    }
    const rows = plan.tables.reduce((n, t) => n + t.rows, 0);
    log(options.dryRun
      ? `dry run: ${plan.tables.length} table(s), ${rows} row(s) loaded and rolled back -- the dump is compatible`
      : `imported ${plan.tables.length} table(s), ${rows} row(s)`);
    return { plan, committed: !options.dryRun };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- sqlite

/**
 * Statements of a sqlite SQL file, one at a time, without reading it all into memory. It knows the
 * four quoting styles, both comment styles, and that a CREATE TRIGGER body has semicolons of its own
 * (the statement ends at `END;`).
 */
async function* sqliteStatements(file: string): AsyncGenerator<string> {
  let buf = '';
  let state: 'code' | "'" | '"' | '[' | '`' | '--' | '/*' = 'code';
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const text = chunk as string;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      buf += ch;
      if (state === 'code') {
        if (ch === "'" || ch === '"' || ch === '`') state = ch;
        else if (ch === '[') state = '[';
        else if (ch === '-' && next === '-') state = '--';
        else if (ch === '/' && next === '*') state = '/*';
        else if (ch === ';') {
          const stmt = buf.trim();
          if (!/^create\s+(temp\s+|temporary\s+)?trigger\b/i.test(stripComments(stmt)) || /\bend\s*;$/i.test(stmt)) {
            if (stripComments(stmt) !== ';') yield stmt;
            buf = '';
          }
        }
      } else if (state === '--') {
        if (ch === '\n') state = 'code';
      } else if (state === '/*') {
        if (ch === '/' && buf.endsWith('*/') && !buf.endsWith('/*/')) state = 'code';
      } else if (state === '[') {
        if (ch === ']') state = 'code';
      } else if (ch === state) {
        // A doubled quote is an escaped one: stay inside.
        if (next === state) { buf += next; i++; } else state = 'code';
      }
    }
  }
  if (stripComments(buf).trim()) throw new Error(`${file} ends in the middle of a statement: ${buf.trim().slice(0, 80)}`);
}

/** The statement without its leading comments (a dump puts a comment block before most statements). */
function stripComments(sql: string): string {
  let out = sql.trimStart();
  for (;;) {
    if (out.startsWith('--')) {
      const nl = out.indexOf('\n');
      out = nl < 0 ? '' : out.slice(nl + 1).trimStart();
    } else if (out.startsWith('/*')) {
      const close = out.indexOf('*/', 2);
      out = close < 0 ? '' : out.slice(close + 2).trimStart();
    } else {
      return out.trimEnd();
    }
  }
}

type SqliteKind = 'control' | 'ddl' | 'insert' | 'sequence' | 'other';

interface SqliteStatement {
  kind: SqliteKind;
  sql: string;
  table?: string;
  columns?: string[] | null;
}

const SQLITE_IDENT = String.raw`(?:"(?:[^"]|"")+"|\[[^\]]+\]|` + '`[^`]+`' + String.raw`|[\w$]+)`;
const sqliteUnquote = (s: string): string =>
  s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.startsWith('[') || s.startsWith('`') ? s.slice(1, -1) : s;

function classify(raw: string): SqliteStatement {
  const sql = stripComments(raw);
  if (/^(pragma|begin|commit|end|rollback|savepoint|release)\b/i.test(sql)) return { kind: 'control', sql };
  if (/^create\s/i.test(sql)) {
    const t = new RegExp(String.raw`^create\s+table\s+(?:if\s+not\s+exists\s+)?(${SQLITE_IDENT})`, 'i').exec(sql);
    return { kind: 'ddl', sql, table: t ? sqliteUnquote(t[1]) : undefined };
  }
  const ins = new RegExp(String.raw`^insert\s+(?:or\s+\w+\s+)?into\s+(${SQLITE_IDENT})\s*(\(([^)]*)\))?\s*values`, 'i').exec(sql);
  if (ins) {
    const table = sqliteUnquote(ins[1]);
    const columns = ins[3] !== undefined ? ins[3].split(',').map((c) => sqliteUnquote(c.trim())) : null;
    return { kind: table === 'sqlite_sequence' ? 'sequence' : 'insert', sql, table, columns };
  }
  if (/^delete\s+from\s+"?sqlite_sequence"?\s*;?$/i.test(sql)) return { kind: 'sequence', sql };
  if (/^analyze\b/i.test(sql) || /^insert\s+into\s+"?sqlite_stat\d/i.test(sql)) return { kind: 'control', sql };
  return { kind: 'other', sql };
}

/** The number of values in the first row of an INSERT, for one without a column list. */
function valueCount(sql: string): number {
  const start = sql.search(/\bvalues\s*\(/i);
  let depth = 0;
  let count = 1;
  let quote: string | null = null;
  for (let i = sql.indexOf('(', start); i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { if (ch === quote) quote = sql[i + 1] === quote ? (i++, quote) : null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
    else if (ch === ',' && depth === 1) count++;
  }
  return count;
}

/**
 * sqlite3 3.50+ `.dump` writes text holding control characters as unistr('a\u000ab'). The SQLite inside
 * the node driver may predate unistr(), so where it has none the call is rewritten into the plain
 * literal it stands for (a newline inside quotes is ordinary SQL).
 */
export function rewriteUnistr(sql: string): string {
  return sql.replace(/unistr\('((?:[^']|'')*)'\)/gi, (_, body: string) => {
    const text = body.replace(/''/g, "'").replace(
      /\\(\\|u[0-9a-fA-F]{4}|\+[0-9a-fA-F]{6}|U[0-9a-fA-F]{8}|[0-9a-fA-F]{4})/g,
      (__, esc: string) => {
        if (esc === '\\') return '\\';
        const hex = esc.replace(/^[uU+]/, '');
        return String.fromCodePoint(parseInt(hex, 16));
      },
    );
    return `'${text.replace(/'/g, "''")}'`;
  });
}

interface SqliteMemory {
  exec(sql: string): Promise<void>;
  all<T>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

interface Sqlite3Module {
  Database: new (file: string) => {
    exec(sql: string, cb: (err: Error | null) => void): void;
    all(sql: string, cb: (err: Error | null, rows: unknown[]) => void): void;
    close(cb: (err: Error | null) => void): void;
  };
}

/**
 * A private :memory: database, to read the dump's own table definitions without touching the target.
 * sqlite3 is the host's (TypeORM's sqlite driver needs it anyway), loaded only here.
 */
async function memoryDatabase(): Promise<SqliteMemory> {
  const loaded = (await import('sqlite3')) as unknown as Sqlite3Module & { default?: Sqlite3Module };
  const sqlite3 = loaded.default ?? loaded;
  const mem = new sqlite3.Database(':memory:');
  return {
    exec: (sql) => new Promise((resolve, reject) => mem.exec(sql, (err) => (err ? reject(err) : resolve()))),
    all: <T>(sql: string) => new Promise<T[]>((resolve, reject) => mem.all(sql, (err, rows) => (err ? reject(err) : resolve(rows as T[])))),
    close: () => new Promise((resolve) => mem.close(() => resolve())),
  };
}

interface SqliteColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

const sqliteColumns = (rows: SqliteColumnInfo[], tableSql: string): TargetColumn[] =>
  rows.map((c) => ({
    name: c.name,
    type: c.type,
    // An INTEGER PRIMARY KEY is the rowid: it fills itself.
    required: c.notnull === 1 && c.dflt_value === null && !(c.pk === 1 && /^integer$/i.test(c.type) && !/without\s+rowid/i.test(tableSql)),
  }));

async function importSqlite(
  runner: QueryRunner,
  db: Dialect,
  options: ImportOptions,
  log: (line: string) => void,
  warn: (line: string) => void,
): Promise<ImportResult> {
  // Pass 1: what the dump creates and fills.
  const created = new Map<string, string>();
  const filled = new Map<string, { rows: number; columns: string[] | null; width: number }>();
  let otherStatements = 0;
  let dumpVersion: string | null = null;
  const ledgerName = db.settings.ledger.table;
  for await (const raw of sqliteStatements(options.file)) {
    const s = classify(raw);
    if (s.kind === 'ddl' && s.table) created.set(s.table, s.sql);
    else if (s.kind === 'insert' && s.table) {
      const f = filled.get(s.table) ?? { rows: 0, columns: s.columns ?? null, width: s.columns ? s.columns.length : valueCount(s.sql) };
      f.rows++;
      filled.set(s.table, f);
      if (s.table === ledgerName) {
        const v = /values\s*\(\s*'((?:[^']|'')*)'/i.exec(s.sql)?.[1];
        if (v && (!dumpVersion || v > dumpVersion)) dumpVersion = v;
      }
    } else if (s.kind === 'other') otherStatements++;
  }
  if (created.size === 0 && filled.size === 0) throw new Error(`${options.file} creates and fills no table: it is not a sqlite dump`);

  const mode = (await db.hasAppTables()) ? 'replace' : 'empty';
  const plan: ImportPlan = {
    driver: 'sqlite', mode, tables: [], errors: [], warnings: [], dumpVersion,
    targetVersion: await db.ledgerVersion(),
  };
  const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
  // Into an existing schema the target keeps its own ledger: it describes the schema it keeps.
  const dumpTables = [...new Set([...created.keys(), ...filled.keys()])]
    .filter((t) => t !== 'sqlite_sequence' && !(mode === 'replace' && t === ledgerName));

  if (mode === 'replace') {
    // The dump's own definitions, read in a private in-memory database.
    const mem = await memoryDatabase();
    const dumpDefs = new Map<string, TargetColumn[]>();
    try {
      for (const [table, sql] of created) {
        await mem.exec(`${sql.replace(/;\s*$/, '')};`);
        dumpDefs.set(table, sqliteColumns(await mem.all<SqliteColumnInfo>(`PRAGMA table_info(${ident(table)})`), sql));
      }
    } finally {
      await mem.close();
    }
    const targetTables: Array<{ name: string; sql: string }> = await runner.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const targetSql = new Map(targetTables.map((t) => [t.name, t.sql]));
    for (const t of targetTables) if (!dumpTables.includes(t.name) && t.name !== ledgerName) plan.warnings.push(`table ${t.name} is not in the dump; it is left as it is`);
    for (const table of dumpTables) {
      const target = targetSql.has(table)
        ? sqliteColumns(await runner.query(`PRAGMA table_info(${ident(table)})`), targetSql.get(table)!)
        : undefined;
      const f = filled.get(table);
      const dumpCols = f?.columns ?? (f ? null : dumpDefs.get(table)?.map((c) => c.name) ?? []);
      compareTable(table, dumpCols, target, plan, f && !f.columns ? f.width : undefined);
      const dumpDef = dumpDefs.get(table);
      if (target && dumpDef) {
        for (const c of dumpDef) {
          const here = target.find((x) => x.name === c.name);
          if (here && here.type.toUpperCase() !== c.type.toUpperCase()) {
            plan.warnings.push(`${table}.${c.name} is ${c.type || 'untyped'} in the dump and ${here.type || 'untyped'} here`);
          }
        }
      }
      const targetRows = target ? Number((await runner.query(`SELECT count(*) AS n FROM ${ident(table)}`))[0].n) : 0;
      plan.tables.push({ name: table, rows: f?.rows ?? 0, targetRows });
    }
    if (otherStatements) plan.warnings.push(`${otherStatements} statement(s) that are neither schema nor INSERTs are skipped into an existing schema`);
  } else {
    for (const table of dumpTables) plan.tables.push({ name: table, rows: filled.get(table)?.rows ?? 0, targetRows: 0 });
  }

  printPlan(plan, options.file, !!options.dryRun, db.settings, log, warn);
  if (plan.errors.length) return { plan, committed: false };
  if (!(await confirmed(plan, options, log))) return { plan, committed: false };

  const hasUnistr = await runner.query("SELECT unistr('x') AS v").then(() => true, () => false);

  // Pass 2: load. foreign_keys can only change outside a transaction.
  await runner.query('PRAGMA foreign_keys = OFF');
  await runner.query('BEGIN');
  let n = 0;
  let current = '';
  let sequenceCleared = false;
  try {
    // The target's triggers must not fire on restored rows (an AFTER INSERT would rewrite them).
    // SQLite cannot disable one, so they are dropped and recreated from their own SQL, in the transaction.
    let triggers: Array<{ name: string; sql: string }> = [];
    if (mode === 'replace') {
      triggers = await runner.query(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${dumpTables.map(sqlText).join(', ')})`,
      );
      for (const t of triggers) await runner.query(`DROP TRIGGER ${ident(t.name)}`);
      for (const table of dumpTables) await runner.query(`DELETE FROM ${ident(table)}`);
    } else if (created.has(ledgerName) && (await db.ledgerExists())) {
      await runner.query(`DROP TABLE ${db.ledger}`);
    }
    for await (const raw of sqliteStatements(options.file)) {
      const s = classify(raw);
      n++;
      if (s.kind === 'control') continue;
      if (mode === 'replace' && (s.kind === 'ddl' || s.kind === 'other' || s.table === ledgerName)) continue;
      if (s.kind === 'sequence' && !sequenceCleared) {
        // Every INSERT above has already advanced sqlite_sequence; the dump's rows replace those, and
        // a stock `.dump` (unlike export) does not clear the table first.
        await runner.query('DELETE FROM sqlite_sequence');
        sequenceCleared = true;
        if (/^delete\b/i.test(s.sql)) continue;
      }
      current = !hasUnistr && /unistr\(/i.test(s.sql) ? rewriteUnistr(s.sql) : s.sql;
      await runner.query(current);
    }
    current = '';
    for (const t of triggers) await runner.query(t.sql);
    const broken: Array<{ table: string; rowid: number; parent: string }> = await runner.query('PRAGMA foreign_key_check');
    if (broken.length) {
      throw new Error(
        `${broken.length} row(s) point at rows that do not exist, e.g. ` +
          broken.slice(0, 5).map((b) => `${b.table} rowid ${b.rowid} -> ${b.parent}`).join('; '),
      );
    }
    await runner.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    await runner.query('ROLLBACK').catch(() => undefined);
    const at = current ? `\nat statement ${n}: ${current.slice(0, 160)}${current.length > 160 ? '...' : ''}` : '';
    throw new Error(`the import failed and was rolled back; this database is unchanged.\n${(error as Error).message}${at}`);
  } finally {
    await runner.query('PRAGMA foreign_keys = ON').catch(() => undefined);
  }
  const rows = plan.tables.reduce((sum, t) => sum + t.rows, 0);
  log(options.dryRun
    ? `dry run: ${plan.tables.length} table(s), ${rows} row(s) loaded and rolled back -- the dump is compatible`
    : `imported ${plan.tables.length} table(s), ${rows} row(s)`);
  return { plan, committed: !options.dryRun };
}
