import { describe, expect, it, vi } from 'vitest';

import { formatExtractionTranscript } from '../../faculties/memory/extraction/chunk-compose.js';
import type { SessionEntry } from '../session/types.js';
import type { LetterRecord, LetterStorePort } from './contracts.js';
import { LetterService } from './service.js';

function record(overrides: Partial<LetterRecord> = {}): LetterRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    author: 'companion',
    recipient: 'partner',
    subject: 'A slow note',
    body: 'There is no hurry in answering this.',
    state: 'placed',
    createdAt: 100,
    updatedAt: 100,
    placedAt: 100,
    ...overrides,
  };
}

function makeStore(): LetterStorePort {
  return {
    create: vi.fn(async input => record({ ...input, updatedAt: input.createdAt })),
    get: vi.fn(),
    list: vi.fn(async () => []),
    place: vi.fn(),
    markRead: vi.fn(async (_id, _reader, at) => record({ state: 'read', readAt: at, updatedAt: at })),
    archive: vi.fn(),
    countWaiting: vi.fn(async () => 0),
    close: vi.fn(),
  };
}

describe('LetterService', () => {
  it('places authored correspondence in the bin and appends the lived exchange to L0 without notification dependencies', async () => {
    const store = makeStore();
    const appended: Omit<SessionEntry, 'id'>[] = [];
    const service = new LetterService({
      store,
      sessionStore: { append: entry => (appended.push(entry), appended.length) },
      now: () => 100,
      createId: () => '11111111-1111-4111-8111-111111111111',
    });

    const letter = await service.compose({
      author: 'companion',
      recipient: 'partner',
      subject: ' A slow note ',
      body: ' There is no hurry in answering this. ',
    });

    expect(letter.state).toBe('placed');
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      author: 'companion', recipient: 'partner', state: 'placed',
    }));
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      channelId: 'letters:bin', role: 'assistant', content: letter.body,
    });
    expect(JSON.parse(appended[0]!.metadata!)).toMatchObject({
      type: 'letter', event: 'composed', author: 'companion', recipient: 'partner',
    });
    expect(formatExtractionTranscript([{ ...appended[0]!, id: 1 }])).toContain(letter.body);
  });

  it('records a recipient-authored L0 read event after the durable transition', async () => {
    const store = makeStore();
    const appended: Omit<SessionEntry, 'id'>[] = [];
    const service = new LetterService({
      store,
      sessionStore: { append: entry => (appended.push(entry), appended.length) },
      now: () => 200,
    });

    await service.read('11111111-1111-4111-8111-111111111111', 'partner');

    expect(store.markRead).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', 'partner', 200,
    );
    expect(appended[0]).toMatchObject({ role: 'user', content: 'Read letter: A slow note' });
    expect(JSON.parse(appended[0]!.metadata!)).toMatchObject({ type: 'letter', event: 'read' });
  });

  it('rejects machinery or same-party authorship shapes before persistence', async () => {
    const store = makeStore();
    const service = new LetterService({ store, sessionStore: { append: vi.fn() } });

    await expect(service.compose({
      author: 'partner', recipient: 'partner', subject: 'x', body: 'y',
    })).rejects.toThrow('directed to the other party');
    expect(store.create).not.toHaveBeenCalled();
  });
});
