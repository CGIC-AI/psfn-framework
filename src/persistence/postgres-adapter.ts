import postgres from 'postgres';
import pgvector from 'pgvector';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DatabaseAdapter,
  DatabaseProvider,
  MutationResult,
  VectorSearchOptions,
  VectorSearchRow,
  ColumnInfo,
  TransactionFn,
} from './db-adapter.js';

import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('PostgresAdapter');

interface PoolConfig {
  max?: number;
  idle_timeout?: number;
  connect_timeout?: number;
  max_lifetime?: number;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly provider: DatabaseProvider = 'postgres';
  private readonly sql: ReturnType<typeof postgres>;
  private readonly migrationPath: string;

  constructor(connectionString: string, poolConfig?: PoolConfig) {
    const config = {
      max: poolConfig?.max ?? 10,
      idle_timeout: poolConfig?.idle_timeout ?? 30,
      connect_timeout: poolConfig?.connect_timeout ?? 30,
      max_lifetime: poolConfig?.max_lifetime,
    };
    this.sql = postgres(connectionString, config);
    
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.migrationPath = path.join(__dirname, 'migrations', 'postgres');
  }

  private convertParams(sql: string, params?: unknown[]): { sql: string; params: unknown[] } {
    if (!params || params.length === 0) {
      return { sql, params: [] };
    }

    let paramIndex = 0;
    const convertedSql = sql.replace(/\?/g, () => {
      const idx = paramIndex + 1;
      paramIndex++;
      return `$${idx}`;
    });

    return { sql: convertedSql, params };
  }

  async initialize(): Promise<void> {
    log.info('Initializing Postgres adapter');
    
    await this.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    
    log.info('Postgres extensions initialized');
  }

  async migrate(): Promise<void> {
    log.info('Running Postgres migrations', { path: this.migrationPath });

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (!fs.existsSync(this.migrationPath)) {
      log.info('No migrations directory found', { path: this.migrationPath });
      return;
    }

    const files = fs.readdirSync(this.migrationPath)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const filePath = path.join(this.migrationPath, file);
      
      const existing = await this.queryOne<{ id: number }>(
        'SELECT id FROM schema_migrations WHERE name = $1',
        [file]
      );

      if (existing) {
        log.debug('Migration already applied', { file });
        continue;
      }

      log.info('Applying migration', { file });
      
      const sqlContent = fs.readFileSync(filePath, 'utf-8');
      await this.exec(sqlContent);
      
      await this.run('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      
      log.info('Migration applied', { file });
    }

    log.info('Migrations complete');
  }

  async close(): Promise<void> {
    log.info('Closing Postgres connection');
    await this.sql.end();
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.sql.unsafe(convertedSql, convertedParams as never[]) as T[];
    return result;
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.sql.unsafe(convertedSql, convertedParams as never[]) as T[];
    return result[0] as T | undefined;
  }

  async run(sql: string, params?: unknown[]): Promise<MutationResult> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.sql.unsafe(convertedSql, convertedParams as never[]);
    const count = (result as unknown as { count?: number }).count;
    return {
      changes: count ?? 0,
      lastInsertRowid: undefined,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }

  async transaction<T>(fn: TransactionFn<T>): Promise<T> {
    const result = await this.sql.begin(async (tx) => {
      const txAdapter = new PostgresTransactionAdapter(tx);
      return fn(txAdapter);
    });
    return result as T;
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

    const operator = metric === 'cosine' ? '<=>' : metric === 'ip' ? '<#>' : '<->';
    
    let sql = `SELECT ${selectColumns}${selectColumns !== '*' ? '' : `, ${table}.*`}, ${table}.${column} ${operator} $1 AS distance`;
    
    if (joinClause) {
      const processedJoin = joinClause
        .replace(/\$VEC_TABLE/g, table)
        .replace(/\$MAIN_TABLE/g, table);
      sql += ` FROM ${table} ${processedJoin}`;
    } else {
      sql += ` FROM ${table}`;
    }
    
    const allClauses: string[] = [];
    
    for (const clause of filterClauses) {
      allClauses.push(clause);
    }
    
    if (allClauses.length > 0) {
      sql += ` WHERE ${allClauses.join(' AND ')}`;
    }
    
    sql += ` ORDER BY ${table}.${column} ${operator} $1 LIMIT $2`;

    const vectorParam = pgvector.toSql(queryVector);
    const allParams: unknown[] = [vectorParam, ...filterParams, limit];

    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, allParams);
    const results = await this.sql.unsafe(convertedSql, convertedParams as never[]);

    return results.map((row: Record<string, unknown>) => {
      const { distance, ...rest } = row;
      return {
        row: rest as T,
        distance: typeof distance === 'number' ? distance : 0,
      };
    });
  }

  async vectorUpsert(
    table: string,
    idColumn: string,
    id: string,
    embeddingColumn: string,
    embedding: number[] | Float32Array,
  ): Promise<void> {
    const vectorParam = pgvector.toSql(embedding);
    const sql = `
      INSERT INTO ${table} (${idColumn}, ${embeddingColumn})
      VALUES ($1, $2)
      ON CONFLICT (${idColumn}) DO UPDATE SET ${embeddingColumn} = $2
    `;
    await this.run(sql, [id, vectorParam]);
  }

  async vectorDelete(
    table: string,
    idColumn: string,
    id: string,
  ): Promise<void> {
    await this.run(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]);
  }

  async hasTable(tableName: string): Promise<boolean> {
    const result = await this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name = $1`,
      [tableName]
    );
    return (result?.count ?? 0) > 0;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const result = await this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count 
       FROM information_schema.columns 
       WHERE table_schema = 'public' 
       AND table_name = $1 
       AND column_name = $2`,
      [tableName, columnName]
    );
    return (result?.count ?? 0) > 0;
  }

  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = await this.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      column_key: string;
    }>(
      `SELECT 
        column_name, 
        data_type, 
        is_nullable, 
        column_default, 
        column_key
       FROM information_schema.columns 
       WHERE table_schema = 'public' 
       AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );

    return rows.map(row => ({
      name: row.column_name,
      type: row.data_type,
      notnull: row.is_nullable === 'NO',
      defaultValue: row.column_default,
      pk: row.column_key === 'PRI',
    }));
  }
}

class PostgresTransactionAdapter implements DatabaseAdapter {
  readonly provider: DatabaseProvider = 'postgres';
  
  constructor(private readonly tx: postgres.TransactionSql) {}

  private convertParams(sql: string, params?: unknown[]): { sql: string; params: unknown[] } {
    if (!params || params.length === 0) {
      return { sql, params: [] };
    }

    let paramIndex = 0;
    const convertedSql = sql.replace(/\?/g, () => {
      const idx = paramIndex + 1;
      paramIndex++;
      return `$${idx}`;
    });

    return { sql: convertedSql, params };
  }

  async initialize(): Promise<void> {
  }

  async migrate(): Promise<void> {
  }

  async close(): Promise<void> {
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.tx.unsafe(convertedSql, convertedParams as never[]) as T[];
    return result;
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.tx.unsafe(convertedSql, convertedParams as never[]) as T[];
    return result[0] as T | undefined;
  }

  async run(sql: string, params?: unknown[]): Promise<MutationResult> {
    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
    const result = await this.tx.unsafe(convertedSql, convertedParams as never[]);
    const count = (result as unknown as { count?: number }).count;
    return {
      changes: count ?? 0,
      lastInsertRowid: undefined,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.tx.unsafe(sql);
  }

  async transaction<T>(_fn: TransactionFn<T>): Promise<T> {
    throw new Error('Nested transactions not supported');
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

    const operator = metric === 'cosine' ? '<=>' : metric === 'ip' ? '<#>' : '<->';
    
    let sql = `SELECT ${selectColumns}${selectColumns !== '*' ? '' : `, ${table}.*`}, ${table}.${column} ${operator} $1 AS distance`;
    
    if (joinClause) {
      const processedJoin = joinClause
        .replace(/\$VEC_TABLE/g, table)
        .replace(/\$MAIN_TABLE/g, table);
      sql += ` FROM ${table} ${processedJoin}`;
    } else {
      sql += ` FROM ${table}`;
    }
    
    const allClauses: string[] = [];
    
    for (const clause of filterClauses) {
      allClauses.push(clause);
    }
    
    if (allClauses.length > 0) {
      sql += ` WHERE ${allClauses.join(' AND ')}`;
    }
    
    sql += ` ORDER BY ${table}.${column} ${operator} $1 LIMIT $2`;

    const vectorParam = pgvector.toSql(queryVector);
    const allParams: unknown[] = [vectorParam, ...filterParams, limit];

    const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, allParams);
    const results = await this.tx.unsafe(convertedSql, convertedParams as never[]);

    return results.map((row: Record<string, unknown>) => {
      const { distance, ...rest } = row;
      return {
        row: rest as T,
        distance: typeof distance === 'number' ? distance : 0,
      };
    });
  }

  async vectorUpsert(
    table: string,
    idColumn: string,
    id: string,
    embeddingColumn: string,
    embedding: number[] | Float32Array,
  ): Promise<void> {
    const vectorParam = pgvector.toSql(embedding);
    const sql = `
      INSERT INTO ${table} (${idColumn}, ${embeddingColumn})
      VALUES ($1, $2)
      ON CONFLICT (${idColumn}) DO UPDATE SET ${embeddingColumn} = $2
    `;
    await this.run(sql, [id, vectorParam]);
  }

  async vectorDelete(
    table: string,
    idColumn: string,
    id: string,
  ): Promise<void> {
    await this.run(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]);
  }

  async hasTable(tableName: string): Promise<boolean> {
    const result = await this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name = $1`,
      [tableName]
    );
    return (result?.count ?? 0) > 0;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const result = await this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count 
       FROM information_schema.columns 
       WHERE table_schema = 'public' 
       AND table_name = $1 
       AND column_name = $2`,
      [tableName, columnName]
    );
    return (result?.count ?? 0) > 0;
  }

  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = await this.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      column_key: string;
    }>(
      `SELECT 
        column_name, 
        data_type, 
        is_nullable, 
        column_default, 
        column_key
       FROM information_schema.columns 
       WHERE table_schema = 'public' 
       AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );

    return rows.map(row => ({
      name: row.column_name,
      type: row.data_type,
      notnull: row.is_nullable === 'NO',
      defaultValue: row.column_default,
      pk: row.column_key === 'PRI',
    }));
  }
}