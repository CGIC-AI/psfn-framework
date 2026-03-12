import { describe, expect, it } from 'vitest';
import { entriesToMessages } from './context-support.js';
import type { SessionEntry } from '../types.js';

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: 1,
    channelId: 'dm:test',
    role: 'user',
    content: 'default',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('entriesToMessages', () => {
  it('reclassifies legacy intention follow-ups as system context', () => {
    const messages = entriesToMessages([
      makeEntry({
        role: 'user',
        content: 'I am still investigating the message flow.',
        authorId: '5435899b-56e0-4482-ab75-12fc19350e91',
        authorName: 'Intention Appraisal',
        metadata: JSON.stringify({
          turn: {
            schemaVersion: 1,
            turnId: 'turn-1',
            requestId: 'intention-follow-up:abc123',
            sourceMessageId: 'intention-follow-up:abc123',
            role: 'user',
          },
        }),
      }),
      makeEntry({
        id: 2,
        role: 'user',
        content: 'This is the actual partner message.',
        authorId: 'user-1',
        authorName: 'Operator',
        timestamp: 1_700_000_000_100,
      }),
    ], 'private');

    expect(messages).toEqual([
      {
        role: 'system',
        content: '[SYSTEM: Intention Appraisal] I am still investigating the message flow.',
      },
      {
        role: 'user',
        content: 'This is the actual partner message.',
      },
    ]);
  });

  it('reclassifies scheduled heartbeat prompts as system context', () => {
    const messages = entriesToMessages([
      makeEntry({
        role: 'user',
        channelId: 'internal:reflection:whisper',
        content: 'Your hourly heartbeat is firing.',
        authorId: 'scheduler',
        authorName: 'Whisper',
      }),
      makeEntry({
        id: 2,
        role: 'assistant',
        channelId: 'internal:reflection:whisper',
        content: 'A quiet thought.',
        timestamp: 1_700_000_000_100,
      }),
    ], 'private');

    expect(messages).toEqual([
      {
        role: 'system',
        content: '[SYSTEM: Whisper] Your hourly heartbeat is firing.',
      },
      {
        role: 'assistant',
        content: 'A quiet thought.',
      },
    ]);
  });
});
