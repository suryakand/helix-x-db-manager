import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { exportDatabase } from '../src/engine/db-export';
import { assertPlainSql, importDatabase } from '../src/engine/db-import';
import { migrateSchema } from '../src/engine/schema-migrate';
import { adminBootstrap, collector, sqliteSource, workspace } from './helpers';

describe('export and import on sqlite', () => {
  let ws: ReturnType<typeof workspace>;
  let source: DataSource;

  beforeEach(async () => {
    ws = workspace();
    source = await sqliteSource(join(ws.dir, 'source.sqlite'));
    await migrateSchema(source, { action: 'apply', dir: ws.migrations, bootstrap: adminBootstrap(), log: () => undefined });
    await source.query("INSERT INTO notes (user_id, body) VALUES (1, 'it''s a note'), (1, 'line one\nline two')");
  });
  afterEach(async () => {
    if (source.isInitialized) await source.destroy();
    ws.cleanup();
  });

  const exportOf = (ds: DataSource): Promise<string> =>
    exportDatabase(ds, { dir: join(ws.dir, 'exports'), name: 'source', fileName: '{name}_{YYYY}{MM}{DD}', log: () => undefined });

  it('writes one file, owner-only, named from the template, never overwriting', async () => {
    const first = await exportOf(source);
    const second = await exportOf(source);
    expect(basename(first)).toMatch(/^source_\d{8}\.sql$/);
    expect(basename(second)).toMatch(/^source_\d{8}_2\.sql$/);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(readFileSync(first, 'utf8')).toContain('INSERT INTO "notes" ("id","user_id","body","created_at")');
  });

  it('loads a dump into a new database: schema, data and ledger', async () => {
    const file = await exportOf(source);
    const target = await sqliteSource(join(ws.dir, 'target.sqlite'));
    try {
      const { plan, committed } = await importDatabase(target, { file, log: () => undefined });
      expect(plan.mode).toBe('empty');
      expect(committed).toBe(true);
      expect(await target.query('SELECT body FROM notes ORDER BY id')).toEqual([{ body: "it's a note" }, { body: 'line one\nline two' }]);
      expect((await target.query('SELECT count(*) AS n FROM schema_migrations'))[0].n).toBe(3);
    } finally {
      await target.destroy();
    }
  });

  it('replaces the data of a database with a schema, keeping its own ledger', async () => {
    const file = await exportOf(source);
    const target = await sqliteSource(join(ws.dir, 'target.sqlite'));
    try {
      await migrateSchema(target, { action: 'apply', dir: ws.migrations, bootstrap: adminBootstrap('other@example.com'), log: () => undefined });
      await target.query("UPDATE schema_migrations SET applied_by = 'target-ledger'");
      const confirmations: number[] = [];
      const { plan, committed } = await importDatabase(target, {
        file,
        confirm: async (p) => (confirmations.push(p.tables.reduce((n, t) => n + t.targetRows, 0)), true),
        log: () => undefined,
        warn: () => undefined,
      });
      expect(plan.mode).toBe('replace');
      expect(committed).toBe(true);
      expect(confirmations).toEqual([3]); // the target's 2 roles and 1 user are deleted
      expect(await target.query('SELECT email FROM users')).toEqual([{ email: 'admin@example.com' }]);
      expect((await target.query("SELECT count(*) AS n FROM schema_migrations WHERE applied_by = 'target-ledger'"))[0].n).toBe(3);
    } finally {
      await target.destroy();
    }
  });

  it('a dry run loads and rolls back; an incompatible dump stops before writing', async () => {
    const file = await exportOf(source);
    const target = await sqliteSource(join(ws.dir, 'target.sqlite'));
    try {
      await migrateSchema(target, { action: 'apply', dir: ws.migrations, bootstrap: adminBootstrap('other@example.com'), log: () => undefined });
      const dry = await importDatabase(target, { file, dryRun: true, log: () => undefined, warn: () => undefined });
      expect(dry.committed).toBe(false);
      expect(dry.plan.errors).toEqual([]);
      expect(await target.query('SELECT email FROM users')).toEqual([{ email: 'other@example.com' }]);

      // The dump has a column this database lacks.
      const out = collector();
      await target.query('ALTER TABLE notes RENAME TO notes_old');
      await target.query('CREATE TABLE notes (id integer PRIMARY KEY, user_id integer NOT NULL, created_at text)');
      const bad = await importDatabase(target, { file, dryRun: true, log: out.log, warn: out.warn });
      expect(bad.plan.errors).toContain('notes: column(s) body are in the dump but not in this database');
      expect(bad.committed).toBe(false);
    } finally {
      await target.destroy();
    }
  });

  it('refuses what is not plain SQL', () => {
    const gz = join(ws.dir, 'dump.sql.gz');
    writeFileSync(gz, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(() => assertPlainSql(gz)).toThrow(/is a gzip file/);
    const custom = join(ws.dir, 'dump.backup');
    writeFileSync(custom, 'PGDMP\u0001\u000e');
    expect(() => assertPlainSql(custom)).toThrow(/pg_dump custom-format archive/);
  });
});
