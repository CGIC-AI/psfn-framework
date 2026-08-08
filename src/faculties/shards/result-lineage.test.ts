import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { buildShardLineageEnvelope } from './result-lineage.js';

const TEST_COMPANION_ID = '11111111-1111-4111-8111-111111111111';

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
    expect(() => buildShardLineageEnvelope(fromAny({
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
    }))).toThrow('Shard lineage source message id cannot be empty');
  });

  it('retains intake snapshots from the source message across foldback lineage', () => {
    const intakeEnvelope = {
      envelopeId: 'source-envelope-1',
      sourceClass: 'document' as const,
      sourceRiskTier: 'untrusted' as const,
      state: 'released' as const,
      riskLabels: ['injection/indirect' as const],
      subject: { kind: 'body' as const },
    };
    const routingEnvelopes = [intakeEnvelope];
    const lineage = buildShardLineageEnvelope({
      kind: 'wyoming',
      coreCompanionId: TEST_COMPANION_ID,
      shardId: 'shard-intake',
      shardChannelId: 'api:source',
      sourceMessage: {
        id: 'source-message',
        channelId: 'api:source',
        channelType: 'api',
        authorId: 'source-user',
        authorName: 'Source User',
        timestamp: new Date('2026-03-28T12:00:00.000Z'),
        routing: { intakeEnvelopes: routingEnvelopes },
      },
    });

    expect(lineage.ingestedIntakeEnvelopes).toEqual([intakeEnvelope]);
    expect(lineage.ingestedIntakeEnvelopes).not.toBe(routingEnvelopes);
    expect(lineage.ingestedIntakeEnvelopes?.[0]).not.toBe(intakeEnvelope);
  });
});
