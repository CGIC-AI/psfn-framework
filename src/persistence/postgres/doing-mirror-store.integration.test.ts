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
const STARVATION_SCHEMA = 'companion_doing_mirror_starvation';
// Deliberately smaller than the poisoned-row count so the bounded oldest-first
// batch is fully occupied by permanently failing rows before the fix.
const STARVATION_BATCH_SIZE = 2;
const STARVATION_MAX_FAILURES = 2;
const POISONED_LETTER_IDS = [
  'c0ffee00-0000-4000-8000-0000000000a1',
  'c0ffee00-0000-4000-8000-0000000000a2',
  'c0ffee00-0000-4000-8000-0000000000a3',
] as const;
const FRESH_LETTER_ID = 'c0ffee00-0000-4000-8000-0000000000b1';

function starvationSource(itemId: string, createdAt: number): DoingMirrorSourceItem {
  return {
    itemType: 'wishlist',
    itemId,
    ref: `wish:${itemId}`,
    title: `Wish ${itemId}`,
    createdAt,
    origin: { kind: 'companion', provenanceRefs: [`wiki:wishlist.wish.${itemId}`] },
  };
}
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

      await expect(service.drainPendingLetters(25, 5))
        .resolves.toEqual({ pending: 1, drained: 1, quarantined: 0 });

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
      await expect(service.drainPendingLetters(25, 5))
        .resolves.toEqual({ pending: 0, drained: 0, quarantined: 0 });
      expect(await mirrorStore.listPendingLetterDeliveries(25)).toEqual([]);
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toHaveLength(1);
      expect(appended).toHaveLength(1);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });

  /**
   * psfn-framework-nwtw1: before per-row failure counting, three permanently
   * failing rows occupied every oldest-first batch of two and the newer pending
   * Letter was never selected again.
   */
  it('quarantines permanently failing rows so a newer pending Letter still drains', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-starvation-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${STARVATION_SCHEMA}`);
    await bootstrap.end();

    const mirrorStore = await PostgresDoingMirrorStore.connect(
      databaseUrl, { schema: STARVATION_SCHEMA },
    );
    const letterStore = await PostgresLetterStore.connect(databaseUrl, { schema: STARVATION_SCHEMA });
    const sessionStore = { append: () => 1 } as unknown as Pick<SessionStore, 'append'>;

    // The poisoned rows reject their content on every attempt; the fresh row
    // fails once (the crash the drain already existed for) and then succeeds.
    const poisoned = new Set<string>(POISONED_LETTER_IDS);
    let poisonCleared = false;
    let freshFailuresLeft = 1;
    const failingLetterStore: LetterStorePort = {
      create: async (input) => {
        if (poisoned.has(input.id) && !poisonCleared) {
          throw new Error('letter content rejected');
        }
        if (input.id === FRESH_LETTER_ID && freshFailuresLeft > 0) {
          freshFailuresLeft -= 1;
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

    const sources = [
      ...POISONED_LETTER_IDS.map((_letterId, index) => starvationSource(`poison-${index}`, 100)),
      starvationSource('fresh', 100),
    ];
    let nowMs = 1_000;
    const letterIds = [...POISONED_LETTER_IDS, FRESH_LETTER_ID];
    let letterCursor = 0;
    const service = new DoingMirrorService({
      store: mirrorStore,
      letters: new LetterService({ store: failingLetterStore, sessionStore, now: () => nowMs }),
      now: () => nowMs,
      createId: () => letterIds[letterCursor++] ?? 'c0ffee00-0000-4000-8000-0000000000ff',
    });
    service.registerSource({
      itemType: 'wishlist',
      list: async () => sources,
      get: async itemId => sources.find(source => source.itemId === itemId) ?? null,
    });

    try {
      // Every row commits its transition and then fails delivery, so all four
      // are pending; the poisoned ones are older and win the oldest-first order.
      for (const source of sources) {
        await expect(service.transition({
          itemType: 'wishlist',
          itemId: source.itemId,
          state: 'considering',
          subject: `About ${source.itemId}`,
          body: 'I am considering this.',
        })).rejects.toThrow(/letter content rejected|letter store unavailable/u);
        nowMs += 10;
      }
      expect(await mirrorStore.listPendingLetterDeliveries(STARVATION_BATCH_SIZE))
        .toMatchObject([{ itemId: 'poison-0' }, { itemId: 'poison-1' }]);

      // Two passes carry the two oldest poisoned rows to the threshold.
      for (let pass = 0; pass < STARVATION_MAX_FAILURES; pass += 1) {
        await expect(
          service.drainPendingLetters(STARVATION_BATCH_SIZE, STARVATION_MAX_FAILURES),
        ).rejects.toThrow('letter content rejected');
      }
      const quarantinedFirst = await mirrorStore.get('wishlist', 'poison-0');
      expect(quarantinedFirst?.notification).toMatchObject({
        failureCount: STARVATION_MAX_FAILURES,
        lastError: 'letter content rejected',
      });
      expect(quarantinedFirst?.notification.quarantinedAt).toBeDefined();

      // The batch is no longer occupied by them, so the newer row is selected.
      expect(await mirrorStore.listPendingLetterDeliveries(STARVATION_BATCH_SIZE))
        .toMatchObject([{ itemId: 'poison-2' }, { itemId: 'fresh' }]);
      await expect(
        service.drainPendingLetters(STARVATION_BATCH_SIZE, STARVATION_MAX_FAILURES),
      ).rejects.toThrow('letter content rejected');
      expect((await mirrorStore.get('wishlist', 'fresh'))?.notification.deliveredAt).toBe(nowMs);
      expect(await letterStore.get(FRESH_LETTER_ID)).toMatchObject({
        id: FRESH_LETTER_ID, author: 'partner', recipient: 'companion', state: 'placed',
      });

      // Once the last poisoned row is quarantined too, the drain is quiet again.
      await expect(
        service.drainPendingLetters(STARVATION_BATCH_SIZE, STARVATION_MAX_FAILURES),
      ).rejects.toThrow('letter content rejected');
      await expect(service.drainPendingLetters(STARVATION_BATCH_SIZE, STARVATION_MAX_FAILURES))
        .resolves.toEqual({ pending: 0, drained: 0, quarantined: 0 });

      // Operator retry after the cause is fixed: the counter resets and the
      // canonical Letter is placed exactly once.
      poisonCleared = true;
      const retried = await service.retryLetterDelivery('wishlist', 'poison-0');
      expect(retried.disposition).toMatchObject({
        state: 'considering',
        notification: { letterId: POISONED_LETTER_IDS[0], failureCount: 0, deliveredAt: nowMs },
      });
      expect(retried.disposition.state === 'open'
        ? undefined
        : retried.disposition.notification.quarantinedAt).toBeUndefined();
      expect(await letterStore.get(POISONED_LETTER_IDS[0])).toMatchObject({ state: 'placed' });

      // A second click neither writes a second Letter nor reopens the row.
      await service.retryLetterDelivery('wishlist', 'poison-0');
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toHaveLength(2);
      expect(await mirrorStore.listPendingLetterDeliveries(STARVATION_BATCH_SIZE)).toEqual([]);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });
}, TIMEOUT_MS);
