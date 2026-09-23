import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { createDefaultBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import { startPostgresTestHarness, type PostgresTestHarness } from '../../../test-support/postgres-test-harness.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { collectAuthorizedBiographicalSources } from './authorized-sources.js';

let harness: PostgresTestHarness | undefined;
let pool: Pool | undefined;
let memoryStore: MemoryStorePort;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  const database = await harness.createDatabase();
  pool = createPostgresPool(database.databaseUrl, { applicationName: 'biography-source-scan-test', allowExitOnIdle: true });
  memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
});

afterAll(async () => {
  await pool?.end();
  await harness?.stop();
});

it('keysets tied timestamps inside the canonical subject authorization boundary', async () => {
  for (const [id, subjectContactId] of [
    ['a-identity', 'contact-a'], ['b-reflection', 'contact-a'],
    ['c-reflection', 'contact-a'], ['z-foreign', 'contact-b'],
  ]) {
    await memoryStore.insertMemory({
      id: id!, text: `Invented evidence ${id}`, type: 'semantic', importance: 0.9, confidence: 1,
      emotionalValence: 0, salience: 0.8, tags: [], sensitivity: 'personal', consentFlags: {},
      sourceRef: 'turn:invented', sourceType: 'turn', extractedAt: 1_000,
      lastAccessed: 1_000, accessCount: 0, provenance: { subjectContactId },
    }, new Float32Array([1, 0, 0, 0]));
  }
  const options = {
    memoryStore, subject: { kind: 'contact' as const, contactId: 'contact-a', subjectVersion: 1 },
    policy: createDefaultBiographicalCandidatePolicy(), scanLimit: 1,
  };
  const first = await collectAuthorizedBiographicalSources(options);
  expect(first.evidence.map(entry => entry.memory.id)).toEqual(['c-reflection']);
  const second = await collectAuthorizedBiographicalSources({ ...options, before: first.nextBefore });
  expect(second.evidence.map(entry => entry.memory.id)).toEqual(['b-reflection']);
  const third = await collectAuthorizedBiographicalSources({ ...options, before: second.nextBefore });
  expect(third.evidence.map(entry => entry.memory.id)).toEqual(['a-identity']);
  expect(third.nextBefore).toBeUndefined();
  await expect(collectAuthorizedBiographicalSources({
    ...options, before: { extractedAt: NaN, memoryId: 'invalid' },
  })).rejects.toThrow('memory list position');
});
