import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveModelUsageLedgerSchema } from './resolve-model-usage-ledger-schema.js';

const COMPANION_IDS = [
  '1b2f6c9e-0000-4000-8000-aaaaaaaaaaaa',
  '2c3a7d0f-1111-4000-8000-bbbbbbbbbbbb',
  '3d4b8e1a-2222-4000-8000-cccccccccccc',
] as const;

function companion(companionId: string, postgresSchema: string, index: number) {
  return {
    companionId,
    companionDataDir: `companions/${companionId}`,
    characterCardPath: `companions/${companionId}/companion.json`,
    postgresSchema,
    postgresRole: `${postgresSchema}_runtime`,
    postgresDatabaseUrlRef: { kind: 'env', envName: `COMPANION_${index}_DATABASE_URL` },
  };
}

describe('resolveModelUsageLedgerSchema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('uses the first canonical companions.json entry for a three-companion fleet', () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-model-usage-topology-'));
    tempDirs.push(systemDataDir);
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
      postgres: {
        sharedMigrationRole: 'shared_schema_migration',
        sharedMigrationDatabaseUrlRef: {
          kind: 'env',
          envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
        },
      },
      companions: [
        companion(COMPANION_IDS[0], 'companion_alpha', 0),
        companion(COMPANION_IDS[1], 'companion_beta', 1),
        companion(COMPANION_IDS[2], 'companion_gamma', 2),
      ],
    }, null, 2)}\n`, 'utf8');

    expect(resolveModelUsageLedgerSchema(systemDataDir)).toBe('companion_alpha');
  });
});
