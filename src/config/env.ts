import { existsSync, readFileSync } from 'node:fs';
import * as dotenv from 'dotenv';

/** What {@link loadEnvFiles} read. */
export interface LoadedEnv {
  /** The files that existed and were read. */
  files: string[];
  /** The keys a file supplied, with the file. Any other key that is set came from the real environment. */
  fromFile: Map<string, string>;
}

/**
 * Lays the env files under the real environment: a key already set is never changed, and an
 * earlier file wins over a later one. dotenv rather than process.loadEnvFile, because it reads
 * `KEY = value` lines too.
 *
 * @param required - files that must exist (an explicit `--env-file`); the rest are skipped when missing.
 */
export function loadEnvFiles(files: string[], required: string[] = []): LoadedEnv {
  const loaded: LoadedEnv = { files: [], fromFile: new Map() };
  for (const file of files) {
    if (!existsSync(file)) {
      if (required.includes(file)) throw new Error(`no env file at ${file}`);
      continue;
    }
    loaded.files.push(file);
    for (const [key, value] of Object.entries(dotenv.parse(readFileSync(file)))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded.fromFile.set(key, file);
      }
    }
  }
  return loaded;
}
