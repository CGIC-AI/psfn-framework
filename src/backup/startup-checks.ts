import type Database from 'better-sqlite3';

export interface DatabaseIntegrityCheckResult {
  ok: boolean;
  details: string[];
}

export interface EmbeddingDimensionValidationResult {
  status: 'match' | 'mismatch' | 'unknown';
  configuredDims: number;
  storedDims: number | null;
}

function firstStringValue(row: Record<string, unknown>): string | null {
  for (const value of Object.values(row)) {
    if (typeof value === 'string') return value;
  }
  return null;
}

export function runDatabaseIntegrityCheck(
  db: Database.Database,
): DatabaseIntegrityCheckResult {
  const rows = db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
  const details = rows
    .map(firstStringValue)
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.length > 0);

  if (details.length === 0) {
    throw new Error('SQLite integrity check returned no status rows');
  }

  if (details.length === 1 && details[0].toLowerCase() === 'ok') {
    return { ok: true, details };
  }

  throw new Error(`SQLite integrity check failed: ${details.join('; ')}`);
}

export function readStoredEmbeddingDimensions(
  db: Database.Database,
): number | null {
  try {
    const schemaRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'l2_memory_embeddings' LIMIT 1")
      .get() as { sql?: unknown } | undefined;
    if (typeof schemaRow?.sql === 'string') {
      const match = schemaRow.sql.match(/embedding\s+["'`]?float\[(\d+)\]["'`]?/i);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }
  } catch {
    // Fall through to sample-based detection.
  }

  try {
    const sample = db
      .prepare('SELECT length(embedding) AS bytes FROM l2_memory_embeddings LIMIT 1')
      .get() as { bytes?: unknown } | undefined;
    if (typeof sample?.bytes === 'number' && sample.bytes > 0 && sample.bytes % 4 === 0) {
      return sample.bytes / 4;
    }
  } catch {
    // Table may not exist yet; unknown dims is acceptable.
  }

  return null;
}

export function validateEmbeddingDimensions(
  db: Database.Database,
  configuredDims: number,
): EmbeddingDimensionValidationResult {
  const storedDims = readStoredEmbeddingDimensions(db);

  if (storedDims === null) {
    return {
      status: 'unknown',
      configuredDims,
      storedDims: null,
    };
  }

  if (storedDims === configuredDims) {
    return {
      status: 'match',
      configuredDims,
      storedDims,
    };
  }

  return {
    status: 'mismatch',
    configuredDims,
    storedDims,
  };
}
