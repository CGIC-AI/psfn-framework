import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresDoingMirrorStore } from './doing-mirror-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_doing_mirror';
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

describe('PostgresDoingMirrorStore', () => {
  it('persists ordered dispositions, decline reasons, and Letter delivery state', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    let store = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
    const considering = await store.transition({
      itemType: 'wishlist',
      itemId: '9863edac-42bd-4b57-a693-fde2f85ffbd1',
      expectedState: 'open',
      expectedVersion: 0,
      state: 'considering',
      reason: 'Checking dates.',
      updatedAt: 100,
      letterId: '83f2437e-1af8-40c4-9710-f6a7b085ad64',
      letterSubject: 'Your moon garden',
      letterBody: 'I am considering this.',
    });
    expect(considering).toMatchObject({ state: 'considering', version: 1 });
    await store.markLetterDelivered(
      considering.itemType,
      considering.itemId,
      considering.notification.letterId,
      110,
    );
    await store.close();

    store = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      const persisted = await store.get(considering.itemType, considering.itemId);
      expect(persisted).toMatchObject({
        state: 'considering',
        notification: { deliveredAt: 110 },
      });
      const declined = await store.transition({
        itemType: considering.itemType,
        itemId: considering.itemId,
        expectedState: 'considering',
        expectedVersion: 1,
        state: 'declined',
        reason: 'The space is not available this season.',
        updatedAt: 200,
        letterId: '90ddc4b8-6f17-4dc0-bf70-4fb0a327807b',
        letterSubject: 'Your moon garden',
        letterBody: 'I cannot make the space this season.',
      });
      expect(declined).toMatchObject({ state: 'declined', version: 2 });
      await expect(store.transition({
        itemType: considering.itemType,
        itemId: considering.itemId,
        expectedState: 'considering',
        expectedVersion: 1,
        state: 'done',
        updatedAt: 201,
        letterId: 'f7dddcfd-b803-4746-98a4-935901153aec',
        letterSubject: 'Stale change',
        letterBody: 'This should not be stored.',
      })).rejects.toThrow('lost its expected-state race');
      expect(await store.list()).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
}, TIMEOUT_MS);
