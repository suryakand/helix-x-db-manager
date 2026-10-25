import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource, QueryRunner } from 'typeorm';
import { Dialect, driverOf } from './dialect';
import { findPgTool, PgConnection, pgToolMajor, runPgTool } from './pg-tools';
import { engineSettings, EngineSettings, EngineSettingsInput } from './settings';

/*
 * export -- everything in the database, schema and data, as one plain SQL file.
 *
 *   postgres  pg_dump --format=plain --no-owner --no-privileges. No ownership or grants, so the file
 *             loads as whichever user imports it. With `columnInserts` the rows are written as
 *             `INSERT INTO t (col, ...) VALUES (...)` (pg_dump --column-inserts) instead of COPY
 *             blocks: slower to load, but every statement stands alone and names its columns, so the
 *             file survives a reordered or widened table and can be read or edited by hand.
 *   sqlite    written here, in the shape of `sqlite3 .dump`: the tables, every row as an INSERT with
 *             its column list, sqlite_sequence, then indexes, triggers and views, in one transaction.
 *             It loads with import, or with `sqlite3 new.sqlite ".read <file>"`.
 *
 * A dump usually holds secrets (password hashes, tokens): it is written as <file>.partial, renamed once
 * complete (an interrupted export never looks finished), and by default readable by its owner only.
 */

/** What {@link exportDatabase} writes and where. */
export interface ExportOptions {
  /** The folder; created when missing. */
  dir: string;
  /** Goes into the file name: usually the database name, or the sqlite file's base name. */
  name: string;
  /**
   * The file name without `.sql`. Tokens: `{name}`, `{YYYY}`, `{MM}` (01-12), `{MON}` (JAN-DEC), `{DD}`,
   * `{HH}`, `{mm}`, `{ss}`. Default `{name}_{DD}_{MON}_{YYYY}`. A name already taken gets `_2`, `_3`, ...
   */
  fileName?: string;
  /** The finished file's mode. Default `0o600`. */
  fileMode?: number;
  /** Postgres: rows as column-list INSERTs, not COPY. SQLite always writes them that way. */
  columnInserts?: boolean;
  /** Ledger, schema and pg tool settings. */
  settings?: EngineSettingsInput | EngineSettings;
  /** Progress lines. Default `console.log`. */
  log?: (line: string) => void;
}

/** The default {@link ExportOptions.fileName}. */
export const DEFAULT_EXPORT_FILE_NAME = '{name}_{DD}_{MON}_{YYYY}';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * The path of the next export: the template filled in, or with `_2`, `_3` ... when that name is
 * already taken. Never an existing file.
 */
export function exportFileName(dir: string, name: string, template = DEFAULT_EXPORT_FILE_NAME, now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    name: name.replace(/[^A-Za-z0-9._-]/g, '_'),
    YYYY: String(now.getFullYear()),
    MM: two(now.getMonth() + 1),
    MON: MONTHS[now.getMonth()],
    DD: two(now.getDate()),
    HH: two(now.getHours()),
    mm: two(now.getMinutes()),
    ss: two(now.getSeconds()),
  };
  const base = template.replace(/\{(\w+)\}/g, (whole, key: string) => tokens[key] ?? whole);
  if (/[/\\]/.test(base) || !base.trim()) throw new Error(`export file name '${base}' must be a plain file name`);
  for (let n = 1; ; n++) {
    const file = join(dir, `${base}${n === 1 ? '' : `_${n}`}.sql`);
    if (!existsSync(file) && !existsSync(`${file}.partial`)) return file;
  }
}

/** The connection pg_dump/psql need, from the DataSource's options. */
export function pgConnectionOf(dataSource: DataSource): PgConnection {
  const o = dataSource.options as { host?: string; port?: number; username?: string; password?: string; database?: string };
  return {
    host: o.host ?? 'localhost',
    port: String(o.port ?? 5432),
    user: o.username ?? '',
    password: o.password ?? '',
    database: String(o.database ?? ''),
  };
}

/** The server's major version (15 for 15.19). */
export async function pgServerMajor(runner: QueryRunner): Promise<number> {
  const [row] = await runner.query('SHOW server_version_num');
  return Math.floor(Number(row.server_version_num) / 10000);
}

/**
 * Writes the whole database to one plain SQL file.
 *
 * @returns the file's path.
 */
export async function exportDatabase(dataSource: DataSource, options: ExportOptions): Promise<string> {
  const log = options.log ?? ((line: string) => console.log(line));
  const settings = engineSettings(options.settings);
  mkdirSync(options.dir, { recursive: true });
  const file = exportFileName(options.dir, options.name, options.fileName);
  const partial = `${file}.partial`;
  const driver = driverOf(dataSource);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const db = new Dialect(driver, dataSource, runner, settings);
    if (await db.ledgerExists()) log(`schema version ${(await db.ledgerVersion()) ?? '(empty ledger)'}`);
    if (driver === 'postgres') await exportPostgres(dataSource, runner, partial, !!options.columnInserts, settings, log);
    else {
      if (options.columnInserts) log('sqlite exports always write column-list INSERTs; --column-inserts changes nothing');
      await exportSqlite(runner, partial, log);
    }
    chmodSync(partial, options.fileMode ?? 0o600);
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    await runner.release();
  }
  log(`exported to ${file}`);
  if ((options.fileMode ?? 0o600) === 0o600) {
    log('a dump usually holds password hashes and tokens; it is readable by you only -- keep it that way');
  }
  return file;
}

async function exportPostgres(
  dataSource: DataSource,
  runner: QueryRunner,
  partial: string,
  columnInserts: boolean,
  settings: EngineSettings,
  log: (line: string) => void,
): Promise<void> {
  const pgDump = findPgTool('pg_dump', settings.pgTools);
  const client = pgToolMajor(pgDump);
  const server = await pgServerMajor(runner);
  // pg_dump refuses a newer server anyway, but with a less helpful message.
  if (client < server) throw new Error(`${pgDump} is version ${client}, older than the server (${server}). Use a pg_dump ${server} or newer.`);
  log(`pg_dump ${client} (${pgDump}) against a ${server} server${columnInserts ? ', rows as column-list INSERTs' : ''}`);
  const args = ['--format=plain', '--no-owner', '--no-privileges', ...(columnInserts ? ['--column-inserts'] : []), `--file=${partial}`];
  await runPgTool(pgDump, args, pgConnectionOf(dataSource));
}

/** Rows read per query; each becomes one INSERT, as `.dump` does. */
const SQLITE_BATCH = 1000;

async function exportSqlite(runner: QueryRunner, partial: string, log: (line: string) => void): Promise<void> {
  const out = createWriteStream(partial, { encoding: 'utf8' });
  const write = (text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(text, (err) => (err ? reject(err) : resolve()));
    });
  const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
  try {
    const objects: Array<{ type: string; name: string; sql: string | null }> = await runner.query(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid",
    );
    const tables = objects.filter((o) => o.type === 'table' && o.sql);
    await write(`-- sqlite dump, ${new Date().toISOString()}, by @helix-x/db-manager. Load with its import, or sqlite3 <file> ".read <this file>".\n`);
    await write('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
    for (const t of tables) await write(`${t.sql};\n`);

    let total = 0;
    for (const t of tables) {
      const columns: Array<{ name: string }> = await runner.query(`PRAGMA table_info(${ident(t.name)})`);
      const list = columns.map((c) => ident(c.name)).join(',');
      // quote() is sqlite's own literal writer: text with '' doubled, blobs as X'..', NULL, numbers bare.
      const values = columns.map((c) => `quote(${ident(c.name)})`).join(" || ',' || ");
      const order = /without\s+rowid/i.test(t.sql ?? '') ? '1' : 'rowid';
      let n = 0;
      for (let offset = 0; ; offset += SQLITE_BATCH) {
        const rows: Array<{ v: string }> = await runner.query(
          `SELECT ${values} AS v FROM ${ident(t.name)} ORDER BY ${order} LIMIT ${SQLITE_BATCH} OFFSET ${offset}`,
        );
        for (const r of rows) await write(`INSERT INTO ${ident(t.name)} (${list}) VALUES(${r.v});\n`);
        n += rows.length;
        if (rows.length < SQLITE_BATCH) break;
      }
      total += n;
    }

    const hasSequence = (await runner.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'"))[0].n > 0;
    if (hasSequence) {
      await write('DELETE FROM sqlite_sequence;\n');
      for (const r of await runner.query('SELECT quote(name) AS name, seq FROM sqlite_sequence')) {
        await write(`INSERT INTO sqlite_sequence (name,seq) VALUES(${r.name},${Number(r.seq)});\n`);
      }
    }
    for (const o of objects.filter((x) => x.type !== 'table' && x.sql)) await write(`${o.sql};\n`);
    await write('COMMIT;\n');
    log(`${tables.length} table(s), ${total} row(s)`);
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}
