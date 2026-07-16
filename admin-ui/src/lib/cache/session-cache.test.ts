import { describe, expect, it } from 'vitest';
import type { AdminSessionMessagesData } from '$lib/types';
import {
  isAdminSessionMessagesData,
  mergeSessionMessagePages,
  sessionMessageCursor,
} from './session-cache';

function transcript(ids: number[], totalMessages = ids.length): AdminSessionMessagesData {
  return {
    sessionId: 'api:test-session',
    channelId: 'api:test-session',
    messages: ids.map(id => ({
      id,
      channelId: 'api:test-session',
      role: id % 2 === 0 ? 'assistant' : 'user',
      content: `message-${id}`,
      timestamp: 1_700_000_000_000 + id,
    })),
    pagination: {
      limit: 100,
      beforeId: null,
      nextBeforeId: null,
      hasMoreOlder: false,
      totalMessages,
      returnedMessages: ids.length,
    },
    messageOntologyViews: [],
    roleEnvelopePreviews: [],
    compactionAuditViews: [],
    turns: [],
  };
}

describe('session transcript cache merge', () => {
  it('merges an overlapping newest-page delta by monotonic message id', () => {
    const cached = transcript([1, 2], 2);
    const fresh = transcript([2, 3], 3);

    const result = mergeSessionMessagePages(cached, fresh, sessionMessageCursor(cached));

    expect(result).toEqual({
      kind: 'merged',
      cursor: '3',
      data: expect.objectContaining({
        messages: [
          expect.objectContaining({ id: 1 }),
          expect.objectContaining({ id: 2 }),
          expect.objectContaining({ id: 3 }),
        ],
        pagination: expect.objectContaining({ returnedMessages: 3, totalMessages: 3 }),
      }),
    });
  });

  it('marks an aged-out or mismatched cursor stale instead of guessing a merge', () => {
    const cached = transcript([1, 2], 2);

    expect(mergeSessionMessagePages(cached, transcript([3, 4], 4), '2'))
      .toEqual({ kind: 'stale_cursor' });
    expect(mergeSessionMessagePages(cached, transcript([2, 3], 3), '1'))
      .toEqual({ kind: 'stale_cursor' });
  });

  it('rejects malformed cached transcript rows before rendering', () => {
    expect(isAdminSessionMessagesData({
      ...transcript([1]),
      messages: [{ id: 'not-a-number' }],
    })).toBe(false);
  });
});
