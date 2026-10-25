import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import type { Bootstrap } from '../src/engine/schema-migrate';
import type { Db } from '../src/engine/dialect';

/** The example project's migrations: the fixture every test builds from. */
export const EXAMPLE_MIGRATIONS = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'example', 'database', 'migrations');

/** A temporary folder with a copy of the example migrations in `migrations/`. Removed by `cleanup`. */
export function workspace(): { dir: string; migrations: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'db-manager-test-'));
  const migrations = join(dir, 'migrations');
  cpSync(EXAMPLE_MIGRATIONS, migrations, { recursive: true });
  return { dir, migrations, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A connected sqlite DataSource on `file`. */
export async function sqliteSource(file: string): Promise<DataSource> {
  const ds = new DataSource({ type: 'sqlite', database: file, entities: [], logging: false });
  await ds.initialize();
  return ds;
}

/** Runs a whole sqlite script (TypeORM's query() runs one statement). */
export function execScript(ds: DataSource, sql: string): Promise<void> {
  const db = (ds.driver as unknown as { databaseConnection: { exec(sql: string, cb: (err: Error | null) => void): void } }).databaseConnection;
  return new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
}

/** PG_TEST_URL, e.g. postgres://user:pass@127.0.0.1:55432/postgres; postgres tests skip without it. */
export const PG_TEST_URL = process.env.PG_TEST_URL;

/** A new, empty postgres database on the PG_TEST_URL server, and a DataSource on it. */
export async function postgresSource(name: string): Promise<{ ds: DataSource; drop: () => Promise<void> }> {
  const url = new URL(PG_TEST_URL!);
  const base = { type: 'postgres' as const, host: url.hostname, port: Number(url.port || 5432), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), entities: [], logging: false };
  const admin = new DataSource({ ...base, database: url.pathname.slice(1) || 'postgres' });
  await admin.initialize();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const ds = new DataSource({ ...base, database: name });
  await ds.initialize();
  return {
    ds,
    drop: async () => {
      if (ds.isInitialized) await ds.destroy();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.destroy();
    },
  };
}

/** The example's bootstrap, as the engine takes it: creates one administrator. */
export function adminBootstrap(email = 'admin@example.com'): Bootstrap & { runs: number } {
  const b = {
    label: 'first administrator',
    runs: 0,
    needed: (db: Db) => db.isEmpty('users'),
    run: async (db: Db) => {
      b.runs++;
      const [role] = await db.query<{ id: number }>(`SELECT id FROM roles WHERE name = ${db.param(1)}`, ['ADMIN']);
      await db.query(`INSERT INTO users (email, password_hash, role_id) VALUES (${db.param(1)}, 'x', ${db.param(2)})`, [email, role.id]);
      return `created administrator ${email}`;
    },
  };
  return b;
}

/** Collects what the engine logs. */
export function collector(): { lines: string[]; warnings: string[]; log: (l: string) => void; warn: (l: string) => void } {
  const lines: string[] = [];
  const warnings: string[] = [];
  return { lines, warnings, log: (l) => lines.push(l), warn: (l) => warnings.push(l) };
}
