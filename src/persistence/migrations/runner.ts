import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createComponentLogger } from '../../logger.js';
import type { DatabaseAdapter } from '../db-adapter.js';

const log = createComponentLogger('MigrationRunner');

const MIGRATIONS_TABLE = 'schema_migrations';

const MIGRATIONS_TABLE_DDL_POSTGRES = `
  CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    filename TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )
`;

async function ensureMigrationsTable(adapter: DatabaseAdapter): Promise<void> {
  if (adapter.provider === 'postgres') {
    await adapter.exec(MIGRATIONS_TABLE_DDL_POSTGRES);
  }
}

async function getAppliedMigrations(adapter: DatabaseAdapter): Promise<Set<string>> {
  const hasIt = await adapter.hasTable(MIGRATIONS_TABLE);
  if (!hasIt) return new Set();
  const rows = await adapter.query<{ filename: string }>(
    `SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename`,
  );
  return new Set(rows.map(r => r.filename));
}

function resolveMigrationsDir(provider: string): string {
  const currentFile = fileURLToPath(import.meta.url);
  return join(dirname(currentFile), provider);
}

function listMigrationFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    return [];
  }
}

export async function runMigrations(adapter: DatabaseAdapter): Promise<number> {
  if (adapter.provider === 'sqlite') {
    log.debug('SQLite uses inline schema creation; skipping file-based migrations');
    return 0;
  }

  await ensureMigrationsTable(adapter);
  const applied = await getAppliedMigrations(adapter);
  const dir = resolveMigrationsDir(adapter.provider);
  const files = listMigrationFiles(dir);

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(dir, file), 'utf-8').trim();
    if (!sql) continue;

    log.info('Applying migration', { file });
    await adapter.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (filename, applied_at) VALUES (?, ?)`,
        [file, Date.now()],
      );
    });
    count++;
  }

  if (count > 0) {
    log.info('Migrations complete', { applied: count });
  }
  return count;
}
