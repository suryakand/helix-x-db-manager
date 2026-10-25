import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DbManagerConfig } from './types';

/**
 * The file names looked for, in this order, in each folder from the working directory up to the
 * nearest folder with a `package.json`.
 */
export const CONFIG_FILE_NAMES = ['db-manager.config.mjs', 'db-manager.config.js', 'db-manager.config.cjs', 'db-manager.config.json'];

/** A config and where it came from. */
export interface LoadedConfig {
  /** The config as the file exported it. */
  config: DbManagerConfig;
  /** The file, or null when none was found (all defaults). */
  file: string | null;
  /** `config.rootDir`, resolved; else the config file's folder; else the working directory. */
  rootDir: string;
}

/**
 * Finds and loads the config: `explicit` when given; else the first of {@link CONFIG_FILE_NAMES}, or a
 * `package.json` with a `dbManager` key, in the working directory or a folder above it, stopping at
 * the nearest `package.json`.
 *
 * @throws Error when `explicit` does not exist, or the file does not load or export an object.
 */
export async function loadConfig(cwd: string = process.cwd(), explicit?: string): Promise<LoadedConfig> {
  const file = explicit ? resolve(cwd, explicit) : findConfig(cwd);
  if (explicit && !existsSync(file!)) throw new Error(`no config file at ${file}`);
  if (!file) return { config: {}, file: null, rootDir: cwd };

  let config: unknown;
  if (file.endsWith('package.json')) {
    config = JSON.parse(readFileSync(file, 'utf8')).dbManager;
  } else if (file.endsWith('.json')) {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      config = mod.default ?? mod;
    } catch (error) {
      throw new Error(`cannot load ${file}: ${(error as Error).message}`);
    }
  }
  if (!config || typeof config !== 'object') throw new Error(`${file} does not export a config object`);
  const c = config as DbManagerConfig;
  return { config: c, file, rootDir: resolve(dirname(file), c.rootDir ?? '.') };
}

/** The nearest config file, from `cwd` up to the project root (the nearest `package.json`), or null. */
export function findConfig(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of CONFIG_FILE_NAMES) if (existsSync(join(dir, name))) return join(dir, name);
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).dbManager) return pkg;
      } catch {
        // An unreadable package.json is not a config.
      }
      // A package.json is the project's root: a config above it belongs to something else.
      return null;
    }
    if (dirname(dir) === dir) return null;
  }
}
