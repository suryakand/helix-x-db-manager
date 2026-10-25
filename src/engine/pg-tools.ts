import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { PgToolSettings } from './settings';

/*
 * pg_dump and psql for export / import. They are found rather than assumed: Homebrew's libpq is
 * keg-only, so on a Mac the tools are usually installed but not on PATH. The connection goes in
 * through the child's environment (PGHOST, PGPASSWORD, ...), never on the command line, where `ps`
 * would show the password.
 */

/** The postgres client tools the engine runs. */
export type PgTool = 'pg_dump' | 'psql';

/** What pg_dump and psql need to connect, passed to them as `PG*` environment variables. */
export interface PgConnection {
  /** PGHOST. */
  host: string;
  /** PGPORT. */
  port: string;
  /** PGUSER. */
  user: string;
  /** PGPASSWORD. */
  password: string;
  /** PGDATABASE. */
  database: string;
}

/** Where to look, in order: binDir, extraDirs, PATH, then the usual Homebrew locations. */
function candidateDirs(settings: PgToolSettings): string[] {
  const dirs: string[] = [];
  if (settings.binDir) dirs.push(settings.binDir);
  dirs.push(...settings.extraDirs);
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean));
  if (!settings.homebrew) return dirs;
  dirs.push('/opt/homebrew/opt/libpq/bin', '/usr/local/opt/libpq/bin');
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
    if (!existsSync(root)) continue;
    // postgresql@18 before postgresql@15: the newest client can talk to every older server.
    const versions = readdirSync(root).filter((d) => /^postgresql(@\d+)?$/.test(d)).sort().reverse();
    dirs.push(...versions.map((d) => join(root, d, 'bin')));
  }
  return dirs;
}

/**
 * The path of the tool.
 *
 * @throws Error saying how to install it when it is not found.
 */
export function findPgTool(tool: PgTool, settings: PgToolSettings): string {
  for (const dir of candidateDirs(settings)) {
    const file = join(dir, tool);
    if (existsSync(file)) return file;
  }
  throw new Error(
    `${tool} was not found (looked in the configured pgTools.binDir, PATH${settings.homebrew ? " and Homebrew's libpq/postgresql" : ''}). ` +
      'Install the postgres client -- `brew install libpq` on a Mac, `apk add postgresql-client` on alpine -- ' +
      'or point pgTools.binDir (PG_BIN_DIR by default) at the folder that holds it.',
  );
}

/** The tool's major version, from `--version` ("pg_dump (PostgreSQL) 18.6" -> 18). */
export function pgToolMajor(file: string): number {
  const out = spawnSync(file, ['--version'], { encoding: 'utf8' });
  const match = /(\d+)(?:\.\d+)?/.exec(out.stdout ?? '');
  if (!match) throw new Error(`cannot read the version of ${file}: ${out.stderr || out.stdout}`);
  return Number(match[1]);
}

const pgEnv = (conn: PgConnection): NodeJS.ProcessEnv => ({
  ...process.env,
  PGHOST: conn.host,
  PGPORT: conn.port,
  PGUSER: conn.user,
  PGPASSWORD: conn.password,
  PGDATABASE: conn.database,
  // psql must not read ~/.psqlrc into a scripted run, and must not prompt for anything.
  PSQLRC: '/dev/null',
});

/**
 * Runs a tool to completion. stderr is collected (it carries psql's error, with the line it failed
 * on) and returned on failure; stdout is passed to `onStdout` line by line when given, else dropped.
 */
export function runPgTool(
  file: string,
  args: string[],
  conn: PgConnection,
  onStdout?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: pgEnv(conn), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (!onStdout) return;
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(onStdout);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending && onStdout) onStdout(pending);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${file} exited with code ${code}`));
    });
  });
}
