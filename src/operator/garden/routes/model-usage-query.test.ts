import { describe, expect, it } from 'vitest';
import { parseModelUsageQuery } from './model-usage-query.js';

describe('parseModelUsageQuery', () => {
  it('parses the attribution filter and grouping surface', () => {
    const parsed = parseModelUsageQuery(new URLSearchParams([
      ['sinceMs', '100'],
      ['untilMs', '200'],
      ['limit', '25'],
      ['companionId', 'companion-a'],
      ['sessionId', 'session-1'],
      ['channelType', 'discord'],
      ['callKind', 'chat'],
      ['callType', 'tool'],
      ['purpose', 'research'],
      ['originType', 'chat'],
      ['chargeLane', 'shard'],
      ['chargeSurface', 'shardLaunch'],
      ['shardId', 'shard-1'],
      ['conversationId', 'conversation-1'],
      ['rootInitiationId', 'root-1'],
      ['workloadType', 'shard'],
      ['workloadId', 'shard-1'],
      ['status', 'success'],
      ['costSource', 'estimate'],
      ['groupBy', 'companionId,channelType'],
      ['groupBy', 'shardId'],
    ]));

    expect(parsed).toEqual({
      ok: true,
      value: {
        sinceMs: 100,
        untilMs: 200,
        limit: 25,
        companionId: 'companion-a',
        sessionId: 'session-1',
        channelType: 'discord',
        callKind: 'chat',
        callType: 'tool',
        purpose: 'research',
        originType: 'chat',
        chargeLane: 'shard',
        chargeSurface: 'shardLaunch',
        shardId: 'shard-1',
        conversationId: 'conversation-1',
        rootInitiationId: 'root-1',
        workloadType: 'shard',
        workloadId: 'shard-1',
        status: 'success',
        costSource: 'estimate',
        groupBy: ['companionId', 'channelType', 'shardId'],
      },
    });
  });

  it.each([
    ['unknown fields', 'wat=1', 'Unsupported'],
    ['duplicate scalars', 'provider=a&provider=b', 'Duplicate provider'],
    ['empty text', 'sessionId=', 'must be non-empty'],
    ['invalid interval', 'sinceMs=200&untilMs=100', 'less than or equal'],
    ['fractional limit', 'limit=1.5', 'safe integer'],
    ['invalid enum', 'channelType=email', 'Invalid channelType'],
    ['invalid grouping', 'groupBy=channelType,wat', 'Invalid groupBy'],
  ])('rejects %s', (_name, query, message) => {
    expect(parseModelUsageQuery(new URLSearchParams(query))).toEqual({
      ok: false,
      error: expect.stringContaining(message),
    });
  });
});
