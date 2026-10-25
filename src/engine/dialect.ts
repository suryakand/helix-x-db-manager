import type { DataSource, QueryRunner } from 'typeorm';
import type { EngineSettings } from './settings';

/*
 * The SQL that differs between postgres and sqlite, shared by the migrator (schema-migrate.ts) and
 * the export/import (db-export.ts, db-import.ts).
 */

/** The two databases the engine supports. */
export type MigrateDriver = 'postgres' | 'sqlite';

/** Which of the two a TypeORM DataSource is. */
export const driverOf = (dataSource: DataSource): MigrateDriver =>
  dataSource.options.type === 'postgres' ? 'postgres' : 'sqlite';

/** A SQL string literal, with quotes doubled. */
export const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The database as a bootstrap hook sees it: one connection, and the few helpers that hide the
 * difference between postgres and sqlite.
 */
export interface Db {
  /** Which database this is. */
  readonly driver: MigrateDriver;
  /** Runs one statement. Parameters are written with {@link Db.param}. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The n-th parameter placeholder: `$1` on postgres, `?` on sqlite. */
  param(n: number): string;
  /** SQL for the current time. */
  readonly now: string;
  /** SQL for a boolean literal: `true`/`false` on postgres, `1`/`0` on sqlite. */
  bool(value: boolean): string;
  /** Whether the table exists (in the configured schema on postgres). */
  tableExists(name: string): Promise<boolean>;
  /** True when the table does not exist or has no rows. */
  isEmpty(table: string): Promise<boolean>;
}

/** The SQL that differs between the two drivers, kept in one place. */
export class Dialect implements Db {
  constructor(
    readonly driver: MigrateDriver,
    private readonly dataSource: DataSource,
    private readonly runner: QueryRunner,
    readonly settings: EngineSettings,
  ) {}

  /** The ledger table, as SQL: schema-qualified on postgres. */
  get ledger(): string {
    return this.driver === 'postgres' ? `${this.settings.schema}.${this.settings.ledger.table}` : this.settings.ledger.table;
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.runner.query(sql, params);
  }

  /** `$1` on postgres, `?` on sqlite. */
  param(n: number): string {
    return this.driver === 'postgres' ? `$${n}` : '?';
  }

  get now(): string {
    return this.driver === 'postgres' ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
  }

  bool(value: boolean): string {
    return this.driver === 'postgres' ? String(value) : value ? '1' : '0';
  }

  async tableExists(name: string): Promise<boolean> {
    if (this.driver === 'postgres') {
      const [row] = await this.query<{ exists: boolean }>(
        `SELECT to_regclass(${this.param(1)}) IS NOT NULL AS exists`, [`${this.settings.schema}.${name}`],
      );
      return row?.exists === true;
    }
    const [row] = await this.query<{ n: number }>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${this.param(1)}`, [name],
    );
    return Number(row?.n) > 0;
  }

  async isEmpty(table: string): Promise<boolean> {
    if (!(await this.tableExists(table))) return true;
    const ref = this.driver === 'postgres' ? `"${this.settings.schema}"."${table.replace(/"/g, '""')}"` : `"${table.replace(/"/g, '""')}"`;
    const [row] = await this.query<{ n: number }>(`SELECT count(*) AS n FROM ${ref}`);
    return Number(row?.n) === 0;
  }

  /** Any table besides the ledger (and sqlite's own bookkeeping): false means a new database. */
  async hasAppTables(): Promise<boolean> {
    const [row] = await this.query<{ n: number }>(
      this.driver === 'postgres'
        ? `SELECT count(*) AS n FROM information_schema.tables
            WHERE table_schema = ${this.param(1)} AND table_name <> ${this.param(2)}`
        : `SELECT count(*) AS n FROM sqlite_master
            WHERE type = 'table' AND name NOT IN (${this.param(1)}, 'sqlite_sequence')`,
      this.driver === 'postgres' ? [this.settings.schema, this.settings.ledger.table] : [this.settings.ledger.table],
    );
    return Number(row?.n) > 0;
  }

  ledgerExists(): Promise<boolean> {
    return this.tableExists(this.settings.ledger.table);
  }

  /** The newest version in the ledger, or null when it is missing or empty. */
  async ledgerVersion(): Promise<string | null> {
    if (!(await this.ledgerExists())) return null;
    const [row] = await this.query<{ v: string | null }>(`SELECT max(version) AS v FROM ${this.ledger}`);
    return row?.v ?? null;
  }

  /**
   * Runs a whole file of statements. TypeORM's query() runs one statement on sqlite, so sqlite goes
   * through the driver's own connection; on postgres a query without parameters is already a
   * multi-statement simple query.
   */
  async exec(sql: string): Promise<void> {
    if (this.driver === 'postgres') {
      await this.runner.query(sql);
      return;
    }
    const db = (this.dataSource.driver as unknown as {
      databaseConnection: { exec(sql: string, cb: (err: Error | null) => void): void };
    }).databaseConnection;
    await new Promise<void>((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
  }

  /** Upsert, because a file may already have recorded itself. */
  recordSql(version: string, checksum: string, who: string): string {
    return `INSERT INTO ${this.ledger} (version, checksum, applied_by) VALUES (${sqlText(version)}, ${sqlText(checksum)}, ${sqlText(who)})
  ON CONFLICT (version) DO UPDATE SET checksum = excluded.checksum, applied_by = excluded.applied_by,
  applied_at = ${this.now}, baselined = ${this.bool(false)};`;
  }
}
