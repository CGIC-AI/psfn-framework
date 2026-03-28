import { describe, expect, it } from 'vitest';
import type { SessionEntry } from './types.js';
import { normalizeSessionEntryAttribution } from './entry-attribution.js';

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: 1,
    channelId: 'internal:reflection:whisper',
    role: 'user',
    content: 'prompt',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('normalizeSessionEntryAttribution', () => {
  it('prefers explicit turn metadata role over legacy author heuristics', () => {
    const attribution = normalizeSessionEntryAttribution(
      makeEntry({
        authorId: 'user-1',
        authorName: 'User',
        metadata: JSON.stringify({
          turn: {
          schemaVersion: 1,
          turnId: 'turn-1',
          requestId: 'request-1',
          sourceMessageId: 'message-1',
          role: 'user',
          speakerRole: 'system',
        },
      }),
      }),
    );

    expect(attribution).toEqual({
      role: 'system',
      authorName: 'User',
    });
  });

  it('still treats legacy scheduler prompts as system when no turn metadata role is present', () => {
    const attribution = normalizeSessionEntryAttribution(
      makeEntry({
        authorId: 'scheduler',
        authorName: 'Whisper',
      }),
    );

    expect(attribution.role).toBe('system');
  });
});
