import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run';
import { sqliteSource, workspace } from './helpers';

/*
 * The CLI in a temporary project, off a terminal (vitest's stdin is not a TTY), so every prompt is
 * replaced by its flag or environment variable.
 */

const CONFIG = `
export default {
  envFile: ['.env'],
  migrations: { dir: 'migrations' },
  sqlite: { fileName: 'app.sqlite' },
  export: { dir: 'exports', fileName: '{name}' },
  banner: { rows: (env) => [['Stack', env.TEST_STACK ?? '']] },
  bootstrap: {
    label: 'first administrator',
    needed: (db) => db.isEmpty('users'),
    questions: [
      { name: 'email', message: 'Email', env: 'TEST_ADMIN_EMAIL', transform: (v) => v.trim().toLowerCase(),
        validate: (v) => v.includes('@') || 'not an email' },
    ],
    run: async (db, a) => {
      await db.query(\`INSERT INTO users (email, password_hash, role_id) VALUES (\${db.param(1)}, 'x', 1)\`, [a.email]);
      return 'created administrator ' + a.email;
    },
  },
};
`;

describe('db-manager CLI', () => {
  let ws: ReturnType<typeof workspace>;
  let output: string[];
  const cwd = process.cwd();
  const saved = { ...process.env };

  beforeEach(() => {
    ws = workspace();
    writeFileSync(join(ws.dir, 'db-manager.config.mjs'), CONFIG);
    writeFileSync(join(ws.dir, '.env'), 'DATABASE_TYPE = sqlite\nDATABASE_FOLDER = .\nTEST_STACK=from-env-file\n');
    process.chdir(ws.dir);
    for (const key of Object.keys(process.env)) if (key.startsWith('DATABASE_') || key.startsWith('TEST_')) delete process.env[key];
    output = [];
    const capture = (...args: unknown[]): void => void output.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
  });
  afterEach(() => {
    process.chdir(cwd);
    process.env = { ...saved };
    vi.restoreAllMocks();
    ws.cleanup();
  });

  const run = (...argv: string[]): Promise<void> => runCli(argv, () => '0.0.0-test');
  const text = (): string => output.join('\n');

  it('shows the target from the config and the env file (KEY = value lines too)', async () => {
    await run('migrate', '--dry-run');
    expect(text()).toContain('Config         db-manager.config.mjs');
    expect(text()).toContain('Stack          from-env-file');
    expect(text()).toMatch(/app\.sqlite \(does not exist -- will be created\)/);
  });

  it('refuses to write without --yes off a terminal, and without the bootstrap variable', async () => {
    await expect(run('migrate')).rejects.toThrow('Pass --yes to proceed');
    await expect(run('migrate', '--yes')).rejects.toThrow(/needs its first administrator.*Set TEST_ADMIN_EMAIL/);
    await expect(run()).rejects.toThrow(/no command given, and there is no terminal/);
  });

  it('builds the database, then exports and imports it', async () => {
    process.env.TEST_ADMIN_EMAIL = ' Admin@Example.com ';
    await run('migrate', '--yes');
    expect(text()).toContain('==> created administrator admin@example.com');

    await run('export');
    const dump = join(ws.dir, 'exports', 'app.sql');
    expect(existsSync(dump)).toBe(true);

    process.env.DATABASE_FOLDER = 'copy';
    mkdirSync(join(ws.dir, 'copy'));
    output.length = 0;
    await run('import', dump, '--yes');
    expect(text()).toContain('(from the environment, not the env file)');
    const copy = await sqliteSource(join(ws.dir, 'copy', 'app.sqlite'));
    try {
      expect(await copy.query('SELECT email FROM users')).toEqual([{ email: 'admin@example.com' }]);
    } finally {
      await copy.destroy();
    }
  });

  it('leaves no empty sqlite file behind after a refused import', async () => {
    writeFileSync(join(ws.dir, 'empty.sql'), '-- nothing\n');
    await expect(run('import', 'empty.sql', '--yes')).rejects.toThrow(/creates and fills no table/);
    expect(readdirSync(ws.dir)).not.toContain('app.sqlite');
  });

  it('prints help and the version', async () => {
    await run('--help');
    await run('--version');
    expect(text()).toContain('Usage: db-manager');
    expect(output).toContain('0.0.0-test');
  });
});
