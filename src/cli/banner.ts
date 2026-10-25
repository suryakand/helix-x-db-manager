import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import type { ResolvedConnection } from '../config/connection';
import type { LoadedEnv } from '../config/env';
import type { DbManagerConfig, Env } from '../config/types';
import { paint } from './colors';

/** Relative to where the command was run when that is shorter, else absolute. */
export const shortPath = (file: string): string => {
  const rel = relative(process.cwd(), file);
  return !rel ? file : rel.startsWith('..') ? file : rel;
};

/** What the banner shows besides the connection. */
export interface BannerInput {
  config: DbManagerConfig;
  configFile: string | null;
  env: Env;
  loadedEnv: LoadedEnv;
  connection: ResolvedConnection;
  migrationsDir: string;
  /** e.g. "apply -- dry run". */
  action: string;
  /** The sqlite file is about to be created (apply, import). */
  creates: boolean;
}

const DEFAULT_LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', ''];

/**
 * Prints what is about to be touched, before anything is. A value set in the shell rather than an env
 * file is marked, so a stale `export DATABASE_DBNAME=...` is easy to spot.
 */
export function printBanner(b: BannerInput): void {
  const { spec, variables } = b.connection;
  const source = (label: string): string => {
    const key = variables.get(label);
    if (!key || b.env[key] === undefined) return '';
    return b.loadedEnv.fromFile.has(key) ? '' : `   ${paint('(from the environment, not the env file)', 'yellow')}`;
  };
  const rows: Array<[string, string]> = [
    ['Config', b.configFile ? shortPath(b.configFile) : '(none -- defaults)'],
    ['Env file', b.loadedEnv.files.length ? b.loadedEnv.files.map(shortPath).join(', ') : '(none -- process environment only)'],
    ['NODE_ENV', b.env.NODE_ENV || '(unset)'],
  ];
  for (const [k, v] of b.config.banner?.rows?.(b.env) ?? []) if (v) rows.push([k, v]);
  rows.push(['Database type', `${spec.type}${source('Database type')}`]);
  if (spec.type === 'postgres') {
    const local = b.config.banner?.localHosts ?? DEFAULT_LOCAL_HOSTS;
    const remote = local.includes(spec.host) ? '' : `   ${paint('<-- REMOTE', ['red', 'bold'])}`;
    rows.push(
      ['Host', `${spec.host}:${spec.port}${remote}${source('Host')}`],
      ['Database', `${spec.database}${source('Database')}`],
      ['User', `${spec.user}${source('User')}`],
    );
  } else {
    const size = existsSync(spec.file)
      ? `${(statSync(spec.file).size / 1024 / 1024).toFixed(1)} MB`
      : paint(b.creates ? 'does not exist -- will be created' : 'does not exist', 'yellow');
    rows.push(['Database', `${spec.file} (${size})${source('Database')}`]);
  }
  rows.push(['Synchronize', `${spec.synchronize ? 'true' : 'false'}${source('Synchronize')}`], ['Migrations', shortPath(b.migrationsDir)]);
  rows.push(['Action', b.action.replace(/-- dry run$/, (dry) => paint(dry, ['cyan', 'bold']))]);

  const title = ` ${b.config.banner?.title ?? 'db-manager target'} `;
  const width = Math.max(...rows.map(([k]) => k.length));
  const rule = Math.max(51, title.length + 32);
  const side = Math.floor((rule - title.length) / 2);
  console.log(`\n${paint('-'.repeat(side), 'dim')}${paint(title, 'bold')}${paint('-'.repeat(rule - side - title.length), 'dim')}`);
  for (const [k, v] of rows) console.log(`  ${paint(k.padEnd(width), 'dim')}  ${v}`);
  console.log(`${paint('-'.repeat(rule), 'dim')}\n`);
}
