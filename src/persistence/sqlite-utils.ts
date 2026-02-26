import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteJournalMode = 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
export type SqliteSynchronousMode = 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';

export interface SqliteInitOptions {
  journalMode?: SqliteJournalMode;
  foreignKeys?: boolean;
  synchronous?: SqliteSynchronousMode;
}

export function configureDatabase(
  db: Database.Database,
  options: SqliteInitOptions = {},
): Database.Database {
  const journalMode = options.journalMode ?? 'WAL';
  db.pragma(`journal_mode = ${journalMode}`);

  if (options.synchronous) {
    db.pragma(`synchronous = ${options.synchronous}`);
  }

  if (options.foreignKeys ?? true) {
    db.pragma('foreign_keys = ON');
  }

  return db;
}

export function initDatabase(
  databasePath: string,
  options: SqliteInitOptions = {},
): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  return configureDatabase(db, options);
}

export function hasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.some(row => row.name === columnName);
}

export function runInTransaction<T>(db: Database.Database, handler: () => T): T {
  return db.transaction(handler)();
}

export function createTransaction<Args extends unknown[], Result>(
  db: Database.Database,
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  return db.transaction(handler);
}
