import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { exportDatabase } from '../src/engine/db-export';
import { importDatabase } from '../src/engine/db-import';
import { migrateSchema } from '../src/engine/schema-migrate';
import { adminBootstrap, PG_TEST_URL, postgresSource, workspace } from './helpers';

/*
 * Against a real server: PG_TEST_URL=postgres://user:pass@host:port/postgres npm test. The user must
 * be allowed to create databases. pg_dump and psql must be installed (see pgTools).
 */
describe.skipIf(!PG_TEST_URL)('postgres', () => {
  let ws: ReturnType<typeof workspace>;
  let source: { ds: DataSource; drop: () => Promise<void> };
  let target: { ds: DataSource; drop: () => Promise<void> };
  let out: string;

  beforeAll(async () => {
    ws = workspace();
    out = mkdtempSync(join(tmpdir(), 'db-manager-pg-'));
    source = await postgresSource('dbm_test_source');
    target = await postgresSource('dbm_test_target');
  });
  afterAll(async () => {
    await source?.drop();
    await target?.drop();
    ws?.cleanup();
    rmSync(out, { recursive: true, force: true });
  });

  it('builds a new database, adopting the file that records itself', async () => {
    const bootstrap = adminBootstrap();
    const result = await migrateSchema(source.ds, { action: 'apply', dir: ws.migrations, bootstrap, log: () => undefined });
    expect(result.applied).toEqual(['000_create_schema_migrations', '001_create_users', '002_create_notes']);
    expect(bootstrap.runs).toBe(1);
    const rows: Array<{ version: string; checksum: string }> = await source.ds.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
    await source.ds.query("INSERT INTO notes (user_id, body) VALUES (1, E'two\\nlines'), (1, 'it''s')");
  });

  it.each([false, true])('exports and loads into an empty database, then replaces it (column inserts: %s)', async (columnInserts) => {
    const file = await exportDatabase(source.ds, { dir: out, name: `src_${columnInserts}`, columnInserts, log: () => undefined });
    await target.ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const empty = await importDatabase(target.ds, { file, log: () => undefined, warn: () => undefined });
    expect(empty.plan.mode).toBe('empty');
    expect(await target.ds.query('SELECT body FROM notes ORDER BY id')).toEqual([{ body: 'two\nlines' }, { body: "it's" }]);

    await target.ds.query("UPDATE users SET email = 'changed@example.com'");
    const replace = await importDatabase(target.ds, { file, log: () => undefined, warn: () => undefined });
    expect(replace.plan.mode).toBe('replace');
    expect(await target.ds.query('SELECT email FROM users')).toEqual([{ email: 'admin@example.com' }]);
    // A foreign key dropped for the load is back.
    const fks = await target.ds.query("SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.notes'::regclass");
    expect(fks).toHaveLength(1);
  });

  it('a dry run that finds a missing column changes nothing', async () => {
    const file = await exportDatabase(source.ds, { dir: out, name: 'src_dry', log: () => undefined });
    await target.ds.query('ALTER TABLE notes DROP COLUMN body');
    const { plan, committed } = await importDatabase(target.ds, { file, dryRun: true, log: () => undefined, warn: () => undefined });
    expect(committed).toBe(false);
    expect(plan.errors).toContain('public.notes: column(s) body are in the dump but not in this database');
  });

  it('holds the configured lock key while it runs', async () => {
    const lockKey = 77_001;
    const seen: unknown[] = [];
    await migrateSchema(source.ds, {
      action: 'status',
      dir: ws.migrations,
      settings: { lockKey },
      log: () => undefined,
      bootstrap: {
        label: 'probe',
        needed: async (db) => {
          seen.push(...(await db.query("SELECT objid FROM pg_locks WHERE locktype = 'advisory'")).map((r) => Number(r.objid)));
          return false;
        },
      },
    });
    expect(seen).toContain(lockKey);
  });
});
