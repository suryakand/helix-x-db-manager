import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { migrateSchema } from '../src/engine/schema-migrate';
import { adminBootstrap, collector, execScript, sqliteSource, workspace } from './helpers';

describe('migrateSchema on sqlite', () => {
  let ws: ReturnType<typeof workspace>;
  let ds: DataSource;

  beforeEach(async () => {
    ws = workspace();
    ds = await sqliteSource(join(ws.dir, 'app.sqlite'));
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    ws.cleanup();
  });

  const ledger = async (): Promise<Array<{ version: string; checksum: string; baselined: number }>> =>
    ds.query('SELECT version, checksum, baselined FROM schema_migrations ORDER BY version');

  it('builds a new database from the first file and runs the bootstrap once', async () => {
    const out = collector();
    const bootstrap = adminBootstrap();
    const result = await migrateSchema(ds, { action: 'apply', dir: ws.migrations, bootstrap, log: out.log, warn: out.warn });
    expect(result.applied).toEqual(['000_create_schema_migrations', '001_create_users', '002_create_notes']);
    expect(bootstrap.runs).toBe(1);
    expect(out.lines).toContain('created administrator admin@example.com');
    expect((await ledger()).map((r) => r.version)).toEqual(result.applied);

    const again = await migrateSchema(ds, { action: 'apply', dir: ws.migrations, bootstrap, log: out.log });
    expect(again.applied).toEqual([]);
    expect(bootstrap.runs).toBe(1);
    expect(out.lines).toContain('nothing pending');
  });

  it('writes nothing on a dry run or a status', async () => {
    const out = collector();
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, dryRun: true, bootstrap: adminBootstrap(), log: out.log });
    await migrateSchema(ds, { action: 'status', dir: ws.migrations, log: out.log });
    expect(await ds.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    expect(out.lines.some((l) => l.includes('would create the first administrator'))).toBe(true);
  });

  it('refuses a database with tables and no ledger, and takes it in with init + baseline', async () => {
    // A database built before the ledger existed: it has what 001 creates.
    await execScript(ds, readFileSync(join(ws.migrations, 'sqlite', '001_create_users.sqlite.sql'), 'utf8'));

    await expect(migrateSchema(ds, { action: 'apply', dir: ws.migrations })).rejects.toThrow(/schema_migrations does not exist/);

    await migrateSchema(ds, { action: 'init', dir: ws.migrations, log: () => undefined });
    await expect(migrateSchema(ds, { action: 'apply', dir: ws.migrations })).rejects.toThrow(/has no rows/);

    const out = collector();
    await migrateSchema(ds, { action: 'baseline', dir: ws.migrations, baselinePrefix: '001', log: out.log });
    expect((await ledger()).map((r) => [r.version, Number(r.baselined)])).toEqual([
      ['000_create_schema_migrations', 1],
      ['001_create_users', 1],
    ]);
    const result = await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: () => undefined });
    expect(result.applied).toEqual(['002_create_notes']);
    expect(result.backup).toMatch(/app\.sqlite\.pre-migrate-/);
  });

  it('adopts a self-recorded row without running the file', async () => {
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: () => undefined });
    await ds.query("UPDATE schema_migrations SET checksum = 'self-recorded' WHERE version = '002_create_notes'");
    const out = collector();
    const result = await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: out.log });
    expect(result.applied).toEqual([]);
    expect(out.lines.some((l) => l.startsWith('adopted 002_create_notes'))).toBe(true);
    expect((await ledger()).find((r) => r.version === '002_create_notes')!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('warns about an applied file that was edited, and refreshes a baselined one', async () => {
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: () => undefined });
    const file = join(ws.migrations, 'sqlite', '002_create_notes.sqlite.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited\n`);
    const out = collector();
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: out.log, warn: out.warn });
    expect(out.warnings.some((w) => w.includes('002_create_notes was edited after it was applied'))).toBe(true);

    await ds.query("UPDATE schema_migrations SET baselined = 1 WHERE version = '002_create_notes'");
    const out2 = collector();
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: out2.log, warn: out2.warn });
    expect(out2.warnings).toEqual([]);
    expect(out2.lines.some((l) => l.startsWith('refreshed the checksum of baselined 002_create_notes'))).toBe(true);
  });

  it('rolls a failing file back and records nothing for it', async () => {
    await migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: () => undefined });
    writeFileSync(join(ws.migrations, 'sqlite', '003_broken.sqlite.sql'), 'CREATE TABLE ok_part (id integer);\nSELECT * FROM no_such_table;\n');
    await expect(migrateSchema(ds, { action: 'apply', dir: ws.migrations, log: () => undefined })).rejects.toThrow(/003_broken failed and was rolled back/);
    expect((await ledger()).map((r) => r.version)).not.toContain('003_broken');
    expect(await ds.query("SELECT name FROM sqlite_master WHERE name = 'ok_part'")).toEqual([]);
  });

  it('names the configured command in its hints', async () => {
    await ds.query('CREATE TABLE legacy (id integer)');
    await expect(
      migrateSchema(ds, { action: 'apply', dir: ws.migrations, settings: { command: 'npm run db:migrate --', baselineHint: '006 for a restored dump' } }),
    ).rejects.toThrow(/npm run db:migrate -- --init[\s\S]*006 for a restored dump/);
  });
});
