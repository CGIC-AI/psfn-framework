import { describe, expect, it } from 'vitest';
import { countIntentionAppraisalArtifacts, entriesToMessages } from './context-support.js';
import type { SessionEntry } from '../types.js';
import {
  buildToolObservationMetadata,
  MASKED_TOOL_OBSERVATION_CONTENT,
  normalizeToolObservation,
} from '../tool-observation.js';

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
  it('counts intention appraisal artifacts before they are stripped from runtime context', () => {
    const entries = [
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
        authorName: 'PrimaryUser',
        timestamp: 1_700_000_000_100,
      }),
    ];

    expect(countIntentionAppraisalArtifacts(entries)).toBe(1);
  });

  it('drops leaked legacy intention follow-ups from runtime context', () => {
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
        authorName: 'PrimaryUser',
        timestamp: 1_700_000_000_100,
      }),
    ], 'private');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'This is the actual partner message.',
      provenance: {
        kind: 'user_direct',
        sourceAuthor: 'partner',
        transformedBy: 'none',
        wording: 'direct',
        safeAsPartnerSpeech: true,
      },
    });
  });

  it('renders group user history with speaker labels before consecutive user messages are merged', () => {
    const messages = entriesToMessages([
      makeEntry({
        channelId: 'discord:kube',
        channelVisibility: 'invite_only',
        role: 'user',
        content: 'first group message',
        authorId: 'vega-id',
        authorName: 'Vega',
      }),
      makeEntry({
        id: 2,
        channelId: 'discord:kube',
        channelVisibility: 'invite_only',
        role: 'user',
        content: 'second group message',
        authorId: 'iku-id',
        authorName: 'Iku',
        timestamp: 1_700_000_000_100,
      }),
    ], 'invite_only');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [
        'Vega (discord:vega-id): first group message',
        'Iku (discord:iku-id): second group message',
      ].join('\n'),
      provenance: {
        kind: 'user_direct',
        sourceSpanCount: 2,
        sourceEntryIds: [1, 2],
      },
    });
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

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: '[SYSTEM: Whisper] Your hourly heartbeat is firing.',
      provenance: {
        kind: 'system_note',
        sourceAuthor: 'system',
        safeAsPartnerSpeech: false,
      },
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'A quiet thought.',
      provenance: {
        kind: 'companion_direct',
        sourceAuthor: 'companion',
        safeAsPartnerSpeech: false,
      },
    });
  });

  it('drops internal-lane instrumentation from assembled context', () => {
    const messages = entriesToMessages([
      makeEntry({
        role: 'system',
        content: 'Admin updated prompt order.',
        authorId: 'system',
        authorName: 'System',
        metadata: JSON.stringify({
          sessionLane: {
            schemaVersion: 1,
            kind: 'internal',
            source: 'appendSystemNote',
          },
        }),
      }),
      makeEntry({
        id: 2,
        role: 'user',
        content: 'What changed?',
        authorId: 'user-1',
        authorName: 'PrimaryUser',
        timestamp: 1_700_000_000_100,
      }),
    ], 'private');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'What changed?',
      provenance: {
        kind: 'user_direct',
        safeAsPartnerSpeech: true,
      },
    });
  });

  it('omits masked stale tool dumps from historical prompt messages', () => {
    const observation = normalizeToolObservation({
      toolName: 'orientation_dump',
      content: 'Orientation note: keep the trust policy lane isolated.',
    });

    const messages = entriesToMessages([
      makeEntry({
        role: 'tool',
        content: MASKED_TOOL_OBSERVATION_CONTENT,
        metadata: buildToolObservationMetadata(undefined, observation.metadata),
      }),
    ], 'private');

    expect(messages).toHaveLength(0);
  });

  it('marks direct user, companion, and system context with distinct authenticity provenance', () => {
    const observation = normalizeToolObservation({
      toolName: 'search',
      content: 'Search result one.',
    });

    const messages = entriesToMessages([
      makeEntry({
        role: 'user',
        content: 'Direct partner words.',
        authorId: 'user-1',
        authorName: 'PrimaryUser',
      }),
      makeEntry({
        id: 2,
        role: 'assistant',
        content: 'Direct companion words.',
        timestamp: 1_700_000_000_100,
      }),
      makeEntry({
        id: 3,
        role: 'system',
        content: 'Quiet planner note.',
        authorId: 'quiet-planner',
        authorName: 'Quiet Planner',
        timestamp: 1_700_000_000_200,
      }),
      makeEntry({
        id: 4,
        role: 'tool',
        content: 'Search result one.',
        timestamp: 1_700_000_000_300,
        metadata: buildToolObservationMetadata(undefined, observation.metadata),
      }),
    ], 'private', true, true);

    expect(messages.map(message => message.provenance?.kind)).toEqual([
      'user_direct',
      'companion_direct',
      'system_note',
    ]);
    expect(messages[0]?.provenance?.safeAsPartnerSpeech).toBe(true);
    expect(messages.slice(1).every(message => message.provenance?.safeAsPartnerSpeech === false)).toBe(true);
  });
});
