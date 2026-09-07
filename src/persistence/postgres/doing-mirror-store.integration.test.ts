import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { DoingMirrorSourceItem } from '../../core/doing-mirror/contracts.js';
import { DoingMirrorService } from '../../core/doing-mirror/service.js';
import {
  LETTER_L0_CHANNEL_ID,
  type LetterStorePort,
} from '../../core/letters/contracts.js';
import { LetterService } from '../../core/letters/service.js';
import type { SessionStore } from '../sessions/store.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresDoingMirrorStore } from './doing-mirror-store.js';
import { PostgresLetterStore } from './letter-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_doing_mirror';
const DRAIN_SCHEMA = 'companion_doing_mirror_drain';
const DRAIN_SOURCE: DoingMirrorSourceItem = {
  itemType: 'wishlist',
  itemId: '9863edac-42bd-4b57-a693-fde2f85ffbd1',
  ref: 'wish:9863edac-42bd-4b57-a693-fde2f85ffbd1',
  title: 'Plant a moon garden',
  createdAt: 100,
  origin: {
    kind: 'companion',
    provenanceRefs: ['wiki:wishlist.wish.9863edac-42bd-4b57-a693-fde2f85ffbd1'],
  },
};
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
      expect(await store.listPendingLetterDeliveries(25)).toMatchObject([{
        state: 'declined',
        notification: { letterId: '90ddc4b8-6f17-4dc0-bf70-4fb0a327807b' },
      }]);
    } finally {
      await store.close();
    }
  });

  it('drains a doing-mirror Letter that failed after the transition committed', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-drain-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${DRAIN_SCHEMA}`);
    await bootstrap.end();

    const mirrorStore = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: DRAIN_SCHEMA });
    const letterStore = await PostgresLetterStore.connect(databaseUrl, { schema: DRAIN_SCHEMA });
    const appended: { channelId: string; metadata?: string }[] = [];
    const sessionStore = {
      append: (entry: { channelId: string; metadata?: string }) => {
        appended.push({ channelId: entry.channelId, ...(entry.metadata ? { metadata: entry.metadata } : {}) });
        return appended.length;
      },
    } as unknown as Pick<SessionStore, 'append'>;

    // The exact failure the drain exists for: `transition` commits, then the
    // authored Letter never reaches the bin.
    let failNextCreate = true;
    const failingLetterStore: LetterStorePort = {
      create: async (input) => {
        if (failNextCreate) {
          failNextCreate = false;
          throw new Error('letter store unavailable');
        }
        return letterStore.create(input);
      },
      get: id => letterStore.get(id),
      list: input => letterStore.list(input),
      place: (id, actor, at) => letterStore.place(id, actor, at),
      markRead: (id, reader, at) => letterStore.markRead(id, reader, at),
      archive: (id, actor, at) => letterStore.archive(id, actor, at),
      countWaiting: recipient => letterStore.countWaiting(recipient),
      close: () => letterStore.close(),
    };
    const letters = new LetterService({ store: failingLetterStore, sessionStore, now: () => 200 });

    const service = new DoingMirrorService({
      store: mirrorStore,
      letters,
      now: () => 300,
      createId: () => 'c0ffee00-0000-4000-8000-000000000001',
    });
    service.registerSource({
      itemType: 'wishlist',
      list: async () => [DRAIN_SOURCE],
      get: async itemId => (itemId === DRAIN_SOURCE.itemId ? DRAIN_SOURCE : null),
    });

    try {
      await expect(service.transition({
        itemType: 'wishlist',
        itemId: DRAIN_SOURCE.itemId,
        state: 'considering',
        subject: 'Your moon garden',
        body: 'I have started looking at dates.',
      })).rejects.toThrow('letter store unavailable');

      const pending = await mirrorStore.listPendingLetterDeliveries(25);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.notification.deliveredAt).toBeUndefined();
      expect(await letterStore.get(pending[0]!.notification.letterId)).toBeNull();

      await expect(service.drainPendingLetters(25)).resolves.toEqual({ pending: 1, drained: 1 });

      const letterId = pending[0]!.notification.letterId;
      expect(await letterStore.get(letterId)).toMatchObject({
        id: letterId, author: 'partner', recipient: 'companion', state: 'placed',
        subject: 'Your moon garden', body: 'I have started looking at dates.',
      });
      expect(await letterStore.countWaiting('companion')).toBe(1);
      expect(appended).toEqual([{
        channelId: LETTER_L0_CHANNEL_ID,
        metadata: JSON.stringify({
          type: 'letter', schemaVersion: 1, event: 'composed', letterId,
          author: 'partner', recipient: 'companion', subject: 'Your moon garden',
        }),
      }]);
      expect((await mirrorStore.get('wishlist', DRAIN_SOURCE.itemId))?.notification.deliveredAt)
        .toBe(300);

      // Exactly once: a second maintenance pass finds nothing and writes nothing.
      await expect(service.drainPendingLetters(25)).resolves.toEqual({ pending: 0, drained: 0 });
      expect(await mirrorStore.listPendingLetterDeliveries(25)).toEqual([]);
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toHaveLength(1);
      expect(appended).toHaveLength(1);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });
}, TIMEOUT_MS);
