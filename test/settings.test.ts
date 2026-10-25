import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConnection } from '../src/config/connection';
import { exportFileName } from '../src/engine/db-export';
import { migrateSchema, migrationFiles } from '../src/engine/schema-migrate';
import { engineSettings } from '../src/engine/settings';
import { parseArgs } from '../src/cli/args';
import { sqliteSource, workspace } from './helpers';

describe('settings', () => {
  let ws: ReturnType<typeof workspace> | undefined;
  afterEach(() => ws?.cleanup());

  it('fills in the defaults and refuses names that are not identifiers', () => {
    expect(engineSettings().ledger.table).toBe('schema_migrations');
    expect(engineSettings({ ledger: { table: 'app_migrations' } }).ledger.initFile).toBe('000_create_schema_migrations');
    expect(() => engineSettings({ ledger: { table: 'x; DROP TABLE y' } })).toThrow(/plain identifier/);
    expect(() => engineSettings({ schema: 'a.b' })).toThrow(/plain identifier/);
  });

  it('reads another folder and suffix, and keeps the twins of a shared folder apart', () => {
    ws = workspace();
    const flat = join(ws.dir, 'flat');
    mkdirSync(flat);
    renameSync(join(ws.migrations, '001_create_users.sql'), join(flat, '001_create_users.sql'));
    renameSync(join(ws.migrations, 'sqlite', '001_create_users.sqlite.sql'), join(flat, '001_create_users.sqlite.sql'));
    const shared = { migrations: { sqlite: { folder: '.' } } };
    expect(migrationFiles(flat, 'postgres', shared).map((f) => f.version)).toEqual(['001_create_users']);
    expect(migrationFiles(flat, 'sqlite', shared).map((f) => f.version)).toEqual(['001_create_users']);
  });

  it('works with a renamed ledger table', async () => {
    ws = workspace();
    const ds = await sqliteSource(join(ws.dir, 'app.sqlite'));
    try {
      rmSync(join(ws.migrations, 'sqlite', '000_create_schema_migrations.sqlite.sql'));
      writeFileSync(join(ws.migrations, 'sqlite', '000_create_app_ledger.sqlite.sql'), 'CREATE TABLE IF NOT EXISTS app_ledger (version text PRIMARY KEY, checksum text NOT NULL, applied_at text NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\')), applied_by text, baselined integer NOT NULL DEFAULT 0);');
      const settings = { ledger: { table: 'app_ledger', initFile: '000_create_app_ledger' } };
      const result = await migrateSchema(ds, { action: 'apply', dir: ws.migrations, settings, log: () => undefined });
      expect(result.applied[0]).toBe('000_create_app_ledger');
      expect((await ds.query('SELECT count(*) AS n FROM app_ledger'))[0].n).toBe(result.applied.length);
      expect(await ds.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'")).toEqual([]);
    } finally {
      await ds.destroy();
    }
  });

  it('fills the export file-name template', () => {
    const now = new Date(2026, 9, 4, 7, 5, 9);
    expect(exportFileName('/x', 'my db', undefined, now)).toBe('/x/my_db_04_OCT_2026.sql');
    expect(exportFileName('/x', 'shop', '{name}-{YYYY}{MM}{DD}-{HH}{mm}{ss}', now)).toBe('/x/shop-20261004-070509.sql');
    expect(() => exportFileName('/x', 'shop', '../{name}', now)).toThrow(/plain file name/);
  });
});

describe('connection', () => {
  it('reads DATABASE_* by default and names a missing variable', () => {
    const spec = resolveConnection({}, '/root', { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'h', DATABASE_USER: 'u', DATABASE_DBNAME: 'd' }).spec;
    expect(spec).toMatchObject({ type: 'postgres', host: 'h', port: 5432, user: 'u', database: 'd' });
    expect(() => resolveConnection({}, '/root', { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'h' })).toThrow('DATABASE_USER is not set');
  });

  it('resolves a sqlite folder from sqlite.baseDir, and takes another prefix', () => {
    const config = { connection: { env: { prefix: 'APP_DB_' } }, sqlite: { baseDir: 'service', fileName: 'app.sqlite' } };
    expect(resolveConnection(config, '/root', { APP_DB_FOLDER: '../data' }).spec).toMatchObject({ type: 'sqlite', file: '/root/data/app.sqlite' });
    expect(resolveConnection(config, '/root', { APP_DB_FOLDER: 'data' }).spec).toMatchObject({ file: '/root/service/data/app.sqlite' });
    expect(resolveConnection(config, '/root', { APP_DB_FILE: 'x.sqlite' }).spec).toMatchObject({ file: '/root/x.sqlite' });
    expect(() => resolveConnection(config, '/root', {})).toThrow('APP_DB_FOLDER is not set');
  });

  it('takes a function', () => {
    const config = { connection: () => ({ type: 'sqlite' as const, file: 'db/app.sqlite' }) };
    expect(resolveConnection(config, '/root', {}).spec).toMatchObject({ file: '/root/db/app.sqlite' });
  });
});

describe('parseArgs', () => {
  it('takes commands and the flag forms, the last one winning', () => {
    expect(parseArgs([]).action).toBe('menu');
    expect(parseArgs(['migrate', '--dry-run'])).toMatchObject({ action: 'apply', dryRun: true });
    expect(parseArgs(['migrate', '--baseline', '006'])).toMatchObject({ action: 'baseline', baselinePrefix: '006' });
    expect(parseArgs(['baseline', '006'])).toMatchObject({ action: 'baseline', baselinePrefix: '006' });
    expect(parseArgs(['import', 'a.sql', '--dry-run'])).toMatchObject({ action: 'import', importFile: 'a.sql', dryRun: true });
    expect(parseArgs(['migrate', '--import'])).toMatchObject({ action: 'import', importFile: null });
    expect(parseArgs(['migrate', 'status'])).toMatchObject({ action: 'status' });
    expect(parseArgs(['import', 'status'])).toMatchObject({ action: 'import', importFile: 'status' });
    expect(parseArgs(['export', '--out', 'x', '--column-inserts'])).toMatchObject({ action: 'export', out: 'x', columnInserts: true });
  });

  it('refuses what does not fit', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['import', '--column-inserts'])).toThrow(/goes with export/);
    expect(() => parseArgs(['baseline'])).toThrow(/needs a value/);
  });
});
