import type { DbManagerConfig } from './types';

/**
 * Returns the config unchanged. It exists for type checking: in `db-manager.config.mjs`,
 * `export default defineConfig({ ... })` gets the editor's completion and errors.
 */
export function defineConfig(config: DbManagerConfig): DbManagerConfig {
  return config;
}
