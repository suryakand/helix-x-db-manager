import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { DataSource, DataSourceOptions } from 'typeorm';
import type { ConnectionEnvNames, ConnectionSpec, DbManagerConfig, EnvConnection, Env } from './types';

/** The connection, and the environment variables it was read from (for the banner). */
export interface ResolvedConnection {
  /** The database. */
  spec: ConnectionSpec;
  /** Label -> variable, for the variables an env-mapped connection read. Empty for a function. */
  variables: Map<string, string>;
}

/** The variable names an env-mapped connection reads, from its prefix and overrides. */
export function connectionEnvNames(connection: EnvConnection): ConnectionEnvNames {
  const p = connection.env.prefix ?? 'DATABASE_';
  return {
    type: `${p}TYPE`,
    host: `${p}HOST`,
    port: `${p}PORT`,
    user: `${p}USER`,
    password: `${p}PASSWORD`,
    database: `${p}DBNAME`,
    folder: `${p}FOLDER`,
    file: `${p}FILE`,
    sync: `${p}SYNC`,
    ...connection.env.names,
  };
}

/**
 * Which database the config points at.
 *
 * @throws Error naming the missing variable or field, or an unsupported type.
 */
export function resolveConnection(config: DbManagerConfig, rootDir: string, env: Env): ResolvedConnection {
  const connection = config.connection ?? { env: {} };
  if (typeof connection === 'function') {
    const spec = connection(env);
    checkSpec(spec, (field) => `connection() returned no ${field}`);
    return { spec: spec.type === 'sqlite' ? { ...spec, file: resolve(rootDir, spec.file) } : spec, variables: new Map() };
  }

  const names = connectionEnvNames(connection);
  const type = env[names.type] || connection.defaultType || 'sqlite';
  const synchronize = env[names.sync] === 'true';
  const variables = new Map<string, string>([['Database type', names.type]]);
  if (type === 'sqlite') {
    let file: string;
    if (env[names.file]) {
      file = resolve(rootDir, env[names.file]!);
      variables.set('Database', names.file);
    } else {
      const folder = env[names.folder];
      const fileName = config.sqlite?.fileName ?? 'database.sqlite';
      if (!folder) throw new Error(`${names.folder} is not set; the sqlite file is ${names.folder}/${fileName} (or set ${names.file})`);
      file = resolve(isAbsolute(folder) ? folder : resolve(rootDir, config.sqlite?.baseDir ?? '.', folder), fileName);
      variables.set('Database', names.folder);
    }
    variables.set('Synchronize', names.sync);
    return { spec: { type: 'sqlite', file, synchronize }, variables };
  }
  if (type === 'postgres') {
    const spec: ConnectionSpec = {
      type: 'postgres',
      host: env[names.host] ?? '',
      port: env[names.port] ? Number.parseInt(env[names.port]!, 10) : 5432,
      user: env[names.user] ?? '',
      password: env[names.password] ?? '',
      database: env[names.database] ?? '',
      synchronize,
    };
    const field: Record<string, keyof ConnectionEnvNames> = { host: 'host', user: 'user', database: 'database' };
    checkSpec(spec, (f) => `${names[field[f]]} is not set`);
    variables.set('Host', names.host).set('Database', names.database).set('User', names.user).set('Synchronize', names.sync);
    return { spec, variables };
  }
  throw new Error(`${names.type} must be postgres or sqlite, got '${type}'`);
}

function checkSpec(spec: ConnectionSpec, missing: (field: string) => string): void {
  if (!spec || (spec.type !== 'postgres' && spec.type !== 'sqlite')) {
    throw new Error(`the connection type must be postgres or sqlite, got '${(spec as { type?: string } | undefined)?.type}'`);
  }
  if (spec.type === 'sqlite') {
    if (!spec.file) throw new Error(missing('file'));
    return;
  }
  for (const field of ['host', 'user', 'database'] as const) if (!spec[field]) throw new Error(missing(field));
}

/** The name an export is filed under and an import asks to be typed: the database, or the sqlite file's base name. */
export function databaseName(spec: ConnectionSpec): string {
  return spec.type === 'postgres' ? spec.database : basename(spec.file, extname(spec.file));
}

/** "'shop' on db.example.com", or the sqlite file. */
export function targetLabel(spec: ConnectionSpec): string {
  return spec.type === 'postgres' ? `'${spec.database}' on ${spec.host}` : spec.file;
}

/** TypeORM options for the spec: no entities, no logging, no synchronize -- the engine only runs SQL. */
export function dataSourceOptions(spec: ConnectionSpec): DataSourceOptions {
  return spec.type === 'postgres'
    ? { type: 'postgres', host: spec.host, port: spec.port, username: spec.user, password: spec.password, database: spec.database, entities: [], logging: false }
    : { type: 'sqlite', database: spec.file, entities: [], logging: false };
}

/** A connected TypeORM DataSource for the spec. */
export async function openDataSource(spec: ConnectionSpec): Promise<DataSource> {
  const { DataSource } = await import('typeorm');
  const dataSource = new DataSource(dataSourceOptions(spec));
  await dataSource.initialize();
  return dataSource;
}
