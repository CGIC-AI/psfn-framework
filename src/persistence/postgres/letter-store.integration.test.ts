import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresLetterStore } from './letter-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_letters';
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

describe('PostgresLetterStore', () => {
  it('persists the directed lifecycle and waiting bin across restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'letter-store-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    let store = await PostgresLetterStore.connect(databaseUrl, { schema: SCHEMA });
    const companionDraft = await store.create({
      id: '11111111-1111-4111-8111-111111111111',
      author: 'companion', recipient: 'partner', subject: 'Draft', body: 'For later.',
      state: 'draft', createdAt: 100,
    });
    expect(companionDraft.state).toBe('draft');
    await expect(store.markRead(companionDraft.id, 'partner', 150)).rejects.toThrow('after placement');
    await store.place(companionDraft.id, 'companion', 200);
    await expect(store.place(companionDraft.id, 'partner', 201)).rejects.toThrow('by its author');
    expect(await store.countWaiting('partner')).toBe(1);
    await store.close();

    store = await PostgresLetterStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      const persisted = await store.get(companionDraft.id);
      expect(persisted).toMatchObject({ state: 'placed', placedAt: 200 });
      expect(await store.list({ party: 'partner', direction: 'inbox', limit: 10 }))
        .toHaveLength(1);
      expect(await store.list({ party: 'companion', limit: 10 })).toHaveLength(1);

      const read = await store.markRead(companionDraft.id, 'partner', 300);
      expect(read).toMatchObject({ state: 'read', readAt: 300 });
      expect(await store.countWaiting('partner')).toBe(0);
      const archived = await store.archive(companionDraft.id, 'companion', 400);
      expect(archived).toMatchObject({ state: 'archived', archivedAt: 400 });
      await expect(store.markRead(companionDraft.id, 'partner', 500)).rejects.toThrow('only be read once');
    } finally {
      await store.close();
    }
  });
}, TIMEOUT_MS);
