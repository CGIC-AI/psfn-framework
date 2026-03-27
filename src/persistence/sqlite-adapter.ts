import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createComponentLogger } from '../logger.js';
import {
  configureDatabase,
} from './sqlite-utils.js';
import type {
  DatabaseAdapter,
  DatabaseProvider,
  MutationResult,
  VectorSearchOptions,
  VectorSearchRow,
  ColumnInfo,
  TransactionFn,
} from './db-adapter.js';

const log = createComponentLogger('SqliteAdapter');

export interface SqliteAdapterOptions {
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
  foreignKeys?: boolean;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly provider: DatabaseProvider = 'sqlite';
  private readonly db: DatabaseType.Database;
  private readonly options: SqliteAdapterOptions;

  constructor(databasePath: string, options?: SqliteAdapterOptions) {
    this.options = options ?? {};
    this.db = new Database(databasePath);
    configureDatabase(this.db, {
      journalMode: this.options.journalMode,
      foreignKeys: this.options.foreignKeys,
      synchronous: this.options.synchronous,
    });
  }

  async initialize(): Promise<void> {
    log.info('Initializing SQLite adapter');
    sqliteVec.load(this.db);
    await Promise.resolve();
  }

  async migrate(): Promise<void> {
    log.info('Migrations handled inline with CREATE TABLE IF NOT EXISTS');
    await Promise.resolve();
  }

  async close(): Promise<void> {
    log.info('Closing database connection');
    this.db.close();
    await Promise.resolve();
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = params ? stmt.all(...params) as T[] : stmt.all() as T[];
    return Promise.resolve(rows);
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) as T | undefined : stmt.get() as T | undefined;
    return Promise.resolve(row);
  }

  async run(sql: string, params?: unknown[]): Promise<MutationResult> {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return Promise.resolve({
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    });
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    await Promise.resolve();
  }

  async transaction<T>(fn: TransactionFn<T>): Promise<T> {
    const txAdapter = new TransactionAdapter(this.db);

    return this.db.transaction(() => {
      return fn(txAdapter);
    })();
  }

  async vectorSearch<T = Record<string, unknown>>(
    options: VectorSearchOptions,
  ): Promise<Array<VectorSearchRow<T>>> {
    const {
      table,
      column,
      queryVector,
      limit,
      metric = 'l2',
      joinClause,
      filterClauses = [],
      filterParams = [],
      selectColumns = '*',
    } = options;

    let vector: Float32Array;
    if (queryVector instanceof Float32Array) {
      vector = queryVector;
    } else {
      vector = new Float32Array(queryVector);
    }

    const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    const vecTableAlias = 'v';
    const mainTableAlias = 'm';

    const distanceColumn = metric === 'cosine' 
      ? `${vecTableAlias}.distance` 
      : `${vecTableAlias}.distance`;

    let sql = `SELECT ${selectColumns}, ${distanceColumn} as distance `;
    sql += `FROM ${table}_embeddings ${vecTableAlias} `;

    if (joinClause) {
      const resolvedJoin = joinClause
        .replace(/\$VEC_TABLE/g, vecTableAlias)
        .replace(/\$MAIN_TABLE/g, mainTableAlias);
      sql += `JOIN ${table} ${mainTableAlias} ON ${mainTableAlias}.id = ${vecTableAlias}.memory_id ${resolvedJoin} `;
    } else {
      sql += `JOIN ${table} ${mainTableAlias} ON ${mainTableAlias}.id = ${vecTableAlias}.memory_id `;
    }

    sql += `WHERE ${vecTableAlias}.${column} MATCH ? AND ${vecTableAlias}.k = ? `;

    if (filterClauses.length > 0) {
      for (const filter of filterClauses) {
        const resolvedFilter = filter
          .replace(/\$MAIN_TABLE/g, mainTableAlias);
        sql += `AND ${resolvedFilter} `;
      }
    }

    sql += `ORDER BY ${vecTableAlias}.distance ASC`;

    const params: unknown[] = [vectorBuffer, limit, ...filterParams];

    const rows = this.db.prepare(sql).all(...params) as Array<T & { distance: number }>;

    return Promise.resolve(
      rows.map(row => {
        const { distance, ...rest } = row;
        return { row: rest as T, distance };
      }),
    );
  }

  async vectorUpsert(
    table: string,
    idColumn: string,
    id: string,
    embeddingColumn: string,
    embedding: number[] | Float32Array,
  ): Promise<void> {
    let vector: Float32Array;
    if (embedding instanceof Float32Array) {
      vector = embedding;
    } else {
      vector = new Float32Array(embedding);
    }

    const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    const embeddingsTable = `${table}_embeddings`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${embeddingsTable} (${idColumn}, ${embeddingColumn}, k)
      VALUES (?, ?, ?)
    `);
    stmt.run(id, vectorBuffer, vector.length);
    await Promise.resolve();
  }

  async vectorDelete(
    table: string,
    idColumn: string,
    id: string,
  ): Promise<void> {
    const embeddingsTable = `${table}_embeddings`;
    const stmt = this.db.prepare(`DELETE FROM ${embeddingsTable} WHERE ${idColumn} = ?`);
    stmt.run(id);
    await Promise.resolve();
  }

  async hasTable(tableName: string): Promise<boolean> {
    const result = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name=?
    `).get(tableName) as { name: string } | undefined;
    return Promise.resolve(result !== undefined);
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return Promise.resolve(rows.some(row => row.name === columnName));
  }

  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columns: ColumnInfo[] = rows.map(row => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull === 1,
      defaultValue: row.dflt_value,
      pk: row.pk === 1,
    }));

    return Promise.resolve(columns);
  }
}

class TransactionAdapter implements DatabaseAdapter {
  readonly provider: DatabaseProvider = 'sqlite';

  constructor(private readonly db: DatabaseType.Database) {}

  async initialize(): Promise<void> {
    await Promise.resolve();
  }

  async migrate(): Promise<void> {
    await Promise.resolve();
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = params ? stmt.all(...params) as T[] : stmt.all() as T[];
    return Promise.resolve(rows);
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) as T | undefined : stmt.get() as T | undefined;
    return Promise.resolve(row);
  }

  async run(sql: string, params?: unknown[]): Promise<MutationResult> {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return Promise.resolve({
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    });
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    await Promise.resolve();
  }

  async transaction<T>(_fn: TransactionFn<T>): Promise<T> {
    throw new Error('Nested transactions not supported');
  }

  async vectorSearch<T = Record<string, unknown>>(
    _options: VectorSearchOptions,
  ): Promise<Array<VectorSearchRow<T>>> {
    throw new Error('Vector search not supported in transaction');
  }

  async vectorUpsert(
    _table: string,
    _idColumn: string,
    _id: string,
    _embeddingColumn: string,
    _embedding: number[] | Float32Array,
  ): Promise<void> {
    throw new Error('Vector upsert not supported in transaction');
  }

  async vectorDelete(
    _table: string,
    _idColumn: string,
    _id: string,
  ): Promise<void> {
    throw new Error('Vector delete not supported in transaction');
  }

  async hasTable(tableName: string): Promise<boolean> {
    const result = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name=?
    `).get(tableName) as { name: string } | undefined;
    return Promise.resolve(result !== undefined);
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return Promise.resolve(rows.some(row => row.name === columnName));
  }

  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columns: ColumnInfo[] = rows.map(row => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull === 1,
      defaultValue: row.dflt_value,
      pk: row.pk === 1,
    }));

    return Promise.resolve(columns);
  }
}