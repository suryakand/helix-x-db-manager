/**
 * `@helix-x/db-manager`: numbered-SQL schema migrations with a ledger, and plain-SQL export and
 * import, for PostgreSQL and SQLite through TypeORM. The `db-manager` CLI drives it from a config
 * file; these exports let a program do the same work directly.
 *
 * @packageDocumentation
 */

export { defineConfig } from './config/define-config';
export type {
  BootstrapConfig,
  BootstrapQuestion,
  ConnectionEnvNames,
  ConnectionSpec,
  DbManagerConfig,
  Env,
  EnvConnection,
  PostgresSpec,
  SqliteSpec,
} from './config/types';
export { CONFIG_FILE_NAMES, findConfig, loadConfig } from './config/load-config';
export type { LoadedConfig } from './config/load-config';
export { loadEnvFiles } from './config/env';
export type { LoadedEnv } from './config/env';
export {
  connectionEnvNames,
  databaseName,
  dataSourceOptions,
  openDataSource,
  resolveConnection,
  targetLabel,
} from './config/connection';
export type { ResolvedConnection } from './config/connection';

export { DEFAULT_SETTINGS, engineSettings } from './engine/settings';
export type { EngineSettings, EngineSettingsInput, MigrationSource, PgToolSettings } from './engine/settings';
export { driverOf, sqlText } from './engine/dialect';
export type { Db, MigrateDriver } from './engine/dialect';
export { bootstrapNeeded, migrateSchema, migrationFiles, migrationSource } from './engine/schema-migrate';
export type { Bootstrap, MigrateAction, MigrateOptions, MigrateResult, MigrationFile } from './engine/schema-migrate';
export { DEFAULT_EXPORT_FILE_NAME, exportDatabase, exportFileName } from './engine/db-export';
export type { ExportOptions } from './engine/db-export';
export { assertPlainSql, importDatabase, rewriteUnistr } from './engine/db-import';
export type { ImportOptions, ImportPlan, ImportResult, ImportTable } from './engine/db-import';
export { findPgTool, pgToolMajor } from './engine/pg-tools';
export type { PgConnection, PgTool } from './engine/pg-tools';
