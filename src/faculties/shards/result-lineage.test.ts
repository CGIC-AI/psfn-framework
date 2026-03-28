import { describe, expect, it } from 'vitest';
import { buildShardLineageEnvelope } from './result-lineage.js';

const TEST_COMPANION_ID = 'companion-test';

describe('buildShardLineageEnvelope', () => {
  it('builds a fold-back lineage envelope from a shard spawn', () => {
    const lineage = buildShardLineageEnvelope({
      kind: 'spawn',
      coreCompanionId: TEST_COMPANION_ID,
      shardId: 'shard-123',
      shardChannelId: 'shard:shard-123',
      sourceMessage: {
        id: 'shard-123',
        channelId: 'shard:shard-123',
        channelType: 'api',
        authorId: TEST_COMPANION_ID,
        authorName: 'Companion',
        timestamp: new Date('2026-03-28T12:00:00.000Z'),
      },
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'req-123',
        turnId: 'turn-123',
      },
    });

    expect(lineage).toEqual({
      schemaVersion: 2,
      kind: 'spawn',
      coreCompanionId: TEST_COMPANION_ID,
      shardCompanionId: `${TEST_COMPANION_ID}::shard-123`,
      shardId: 'shard-123',
      shardChannelId: 'shard:shard-123',
      companionProvenance: {
        parentCompanionId: TEST_COMPANION_ID,
        shardCompanionId: `${TEST_COMPANION_ID}::shard-123`,
      },
      sourceMessage: {
        id: 'shard-123',
        channelId: 'shard:shard-123',
        channelType: 'api',
        authorId: TEST_COMPANION_ID,
        authorName: 'Companion',
        timestampMs: new Date('2026-03-28T12:00:00.000Z').getTime(),
        isDirectMessage: false,
      },
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'req-123',
        turnId: 'turn-123',
      },
    });
  });

  it('fails closed when the source message is malformed', () => {
    expect(() => buildShardLineageEnvelope({
      kind: 'wyoming',
      coreCompanionId: TEST_COMPANION_ID,
      shardId: 'shard-123',
      shardChannelId: 'api:wyoming:ha-main:voice-pe-kitchen',
      sourceMessage: {
        id: '  ',
        channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        timestamp: new Date('2026-03-28T12:00:00.000Z'),
      },
    } as any)).toThrow('Shard lineage source message id cannot be empty');
  });
});
