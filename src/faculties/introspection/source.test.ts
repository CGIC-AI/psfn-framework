import { describe, expect, it } from 'vitest';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { createTurnRecordIntrospectionSource } from './source.js';

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'request-1',
    channelId: 'discord:public-room',
    channelType: 'discord',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_100,
    status: 'completed',
    auditPrivacy: {
      schemaVersion: 1,
      contentMode: 'verbatim_public',
      channelPrivacy: 'public',
      contentSensitivity: 'non_intimate',
      reason: 'explicit_public_non_dm',
    },
    userMessage: { role: 'user', content: 'Public question', timestamp: 1_700_000_000_000 },
    assistantMessage: { role: 'assistant', content: 'Public answer', timestamp: 1_700_000_000_100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'model' },
    provenanceRefs: [],
    ...overrides,
  };
}

describe('turn-record introspection source', () => {
  it('selects only explicit public verbatim turns in exact consent channels', () => {
    const intimateSentinel = 'PRIVATE_INTIMATE_SENTINEL';
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [
        { sessionId: 'discord:public-room', sourceChannelId: 'discord:public-room' },
        { sessionId: 'discord:private-dm', sourceChannelId: 'discord:private-dm' },
      ],
      getRecentTurnRecords: (channelId) => channelId === 'discord:public-room'
        ? [
          record(),
          record({
            turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e5f',
            auditPrivacy: {
              schemaVersion: 1,
              contentMode: 'emotional_signal_only',
              channelPrivacy: 'public',
              contentSensitivity: 'intimate',
              reason: 'intimate_content',
            },
            userMessage: { role: 'user', content: intimateSentinel, timestamp: 1_700_000_000_000 },
          }),
        ]
        : [record({
          channelId: 'discord:private-dm',
          auditPrivacy: {
            schemaVersion: 1,
            contentMode: 'emotional_signal_only',
            channelPrivacy: 'private',
            contentSensitivity: 'intimate',
            reason: 'direct_message',
          },
          userMessage: { role: 'user', content: intimateSentinel, timestamp: 1_700_000_000_000 },
        })],
    });

    const candidates = source.listCandidates({
      allowedPublicChannelIds: ['discord:public-room'],
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    });

    expect(candidates).toHaveLength(1);
    expect(JSON.stringify(candidates)).not.toContain(intimateSentinel);
  });

  it('fails closed for legacy records without an audit privacy snapshot', () => {
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [{ sessionId: 'discord:public-room', sourceChannelId: 'discord:public-room' }],
      getRecentTurnRecords: () => [record({ auditPrivacy: undefined })],
    });
    expect(source.listCandidates({
      allowedPublicChannelIds: ['discord:public-room'],
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    })).toEqual([]);
  });

  it('reads routed turns from the source stream without widening consent to the logical session', () => {
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [{
        sessionId: 'session:logical-after-reset',
        sourceChannelId: 'discord:public-room',
      }],
      getRecentTurnRecords: (sourceChannelId) => sourceChannelId === 'discord:public-room'
        ? [record({ sessionId: 'session:logical-after-reset' })]
        : [],
    });
    const input = {
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    };

    expect(source.listCandidates({
      ...input,
      allowedPublicChannelIds: ['session:logical-after-reset'],
    })).toEqual([]);
    expect(source.listCandidates({
      ...input,
      allowedPublicChannelIds: ['discord:public-room'],
    })).toEqual([expect.objectContaining({
      channelId: 'discord:public-room',
      provenanceRefs: expect.arrayContaining(['session:session:logical-after-reset']),
    })]);
  });
});
