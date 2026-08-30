import { describe, expect, it, vi } from 'vitest';

import type { LetterRecord } from '../letters/contracts.js';
import type { LetterService } from '../letters/service.js';
import {
  type DoingMirrorDispositionRecord,
  type DoingMirrorSourceItem,
  type DoingMirrorStorePort,
  type DoingMirrorTransitionStoreInput,
} from './contracts.js';
import { DoingMirrorService } from './service.js';

const SOURCE: DoingMirrorSourceItem = {
  itemType: 'wishlist',
  itemId: '9863edac-42bd-4b57-a693-fde2f85ffbd1',
  ref: 'wish:9863edac-42bd-4b57-a693-fde2f85ffbd1',
  title: 'Plant a moon garden',
  summary: 'Try it next spring.',
  createdAt: 100,
  origin: {
    kind: 'companion',
    provenanceRefs: ['wiki:wishlist.wish.9863edac-42bd-4b57-a693-fde2f85ffbd1'],
  },
};

function makeHarness() {
  const records = new Map<string, DoingMirrorDispositionRecord>();
  let nextLetter = 0;
  const store: DoingMirrorStorePort = {
    get: vi.fn(async (itemType, itemId) => records.get(`${itemType}:${itemId}`) ?? null),
    list: vi.fn(async () => [...records.values()]),
    transition: vi.fn(async (input: DoingMirrorTransitionStoreInput) => {
      const record: DoingMirrorDispositionRecord = {
        itemType: input.itemType,
        itemId: input.itemId,
        state: input.state,
        ...(input.reason ? { reason: input.reason } : {}),
        version: input.expectedVersion + 1,
        updatedAt: input.updatedAt,
        updatedBy: 'partner',
        notification: {
          letterId: input.letterId,
          subject: input.letterSubject,
          body: input.letterBody,
        },
      };
      records.set(`${record.itemType}:${record.itemId}`, record);
      return record;
    }),
    markLetterDelivered: vi.fn(async (itemType, itemId, letterId, deliveredAt) => {
      const current = records.get(`${itemType}:${itemId}`);
      if (!current || current.notification.letterId !== letterId) throw new Error('missing transition');
      const delivered = {
        ...current,
        notification: { ...current.notification, deliveredAt },
      };
      records.set(`${itemType}:${itemId}`, delivered);
      return delivered;
    }),
    close: vi.fn(async () => undefined),
  };
  const compose = vi.fn(async (input: {
    id?: string;
    author: 'partner';
    recipient: 'companion';
    subject: string;
    body: string;
  }): Promise<LetterRecord> => ({
    id: input.id ?? `letter-${++nextLetter}`,
    author: input.author,
    recipient: input.recipient,
    subject: input.subject,
    body: input.body,
    state: 'placed',
    createdAt: 200,
    updatedAt: 200,
    placedAt: 200,
  }));
  const service = new DoingMirrorService({
    store,
    letters: { compose } as unknown as Pick<LetterService, 'compose'>,
    now: () => 200,
    createId: () => '83f2437e-1af8-40c4-9710-f6a7b085ad64',
  });
  service.registerSource({
    itemType: 'wishlist',
    list: async () => [SOURCE],
    get: async itemId => itemId === SOURCE.itemId ? SOURCE : null,
  });
  return { service, store, compose, records };
}

describe('DoingMirrorService', () => {
  it('projects an unhandled companion-originated item as open', async () => {
    const { service } = makeHarness();

    await expect(service.list()).resolves.toEqual([{
      source: SOURCE,
      disposition: {
        itemType: 'wishlist',
        itemId: SOURCE.itemId,
        state: 'open',
        version: 0,
        updatedAt: SOURCE.createdAt,
        updatedBy: 'companion',
      },
    }]);
  });

  it('requires open → considering → terminal and a decline reason', async () => {
    const { service } = makeHarness();
    const letter = { subject: 'About your moon garden', body: 'I am considering this carefully.' };

    await expect(service.transition({
      itemType: 'wishlist', itemId: SOURCE.itemId, state: 'done', ...letter,
    })).rejects.toThrow('open disposition can only move to considering');

    await service.transition({
      itemType: 'wishlist', itemId: SOURCE.itemId, state: 'considering', ...letter,
    });

    await expect(service.transition({
      itemType: 'wishlist',
      itemId: SOURCE.itemId,
      state: 'declined',
      subject: 'About your moon garden',
      body: 'I cannot take this on.',
    })).rejects.toThrow('declined disposition requires a reason');
  });

  it('stores the transition before placing an exact partner-authored Letter', async () => {
    const { service, store, compose } = makeHarness();

    const item = await service.transition({
      itemType: 'wishlist',
      itemId: SOURCE.itemId,
      state: 'considering',
      reason: 'Checking the planting calendar.',
      subject: 'Your moon garden',
      body: 'I have started looking at dates.',
    });

    expect(store.transition).toHaveBeenCalledBefore(compose);
    expect(compose).toHaveBeenCalledWith({
      id: '83f2437e-1af8-40c4-9710-f6a7b085ad64',
      author: 'partner',
      recipient: 'companion',
      subject: 'Your moon garden',
      body: 'I have started looking at dates.',
    });
    expect(item.disposition).toMatchObject({
      state: 'considering',
      reason: 'Checking the planting calendar.',
      notification: { deliveredAt: 200 },
    });
  });

  it('retries a persisted pending Letter without advancing the lifecycle twice', async () => {
    const { service, store, compose } = makeHarness();
    compose.mockRejectedValueOnce(new Error('letter store unavailable'));
    const input = {
      itemType: 'wishlist' as const,
      itemId: SOURCE.itemId,
      state: 'considering' as const,
      subject: 'Your moon garden',
      body: 'I am considering it.',
    };

    await expect(service.transition(input)).rejects.toThrow('letter store unavailable');
    await expect(service.transition(input)).resolves.toMatchObject({
      disposition: { state: 'considering', notification: { deliveredAt: 200 } },
    });
    expect(store.transition).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(2);
  });

  it('fails closed for an unregistered or missing source item', async () => {
    const { service } = makeHarness();

    await expect(service.get('fold_package', 'fold-1')).rejects.toThrow(
      'doing-mirror item type fold_package is not registered',
    );
    await expect(service.get('wishlist', '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'doing-mirror wishlist item was not found',
    );
  });
});
