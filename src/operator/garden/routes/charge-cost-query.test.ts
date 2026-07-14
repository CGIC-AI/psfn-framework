import { describe, expect, it } from 'vitest';
import { parseChargeCostQuery } from './charge-cost-query.js';

describe('parseChargeCostQuery', () => {
  it('parses the bounded operator reconciliation filters', () => {
    expect(parseChargeCostQuery(new URLSearchParams({
      sinceMs: '100',
      untilMs: '200',
      companionId: 'companion-a',
      channelId: 'channel-a',
      lane: 'shard',
      surface: 'externalModelConsult',
      runId: 'run-a',
      rootRunId: 'root-a',
    }))).toEqual({
      ok: true,
      value: {
        sinceMs: 100,
        untilMs: 200,
        companionId: 'companion-a',
        channelId: 'channel-a',
        lane: 'shard',
        surface: 'externalModelConsult',
        runId: 'run-a',
        rootRunId: 'root-a',
      },
    });
  });

  it.each([
    ['unknown fields', 'wat=1', 'Unsupported'],
    ['duplicate scalars', 'runId=a&runId=b', 'Duplicate runId'],
    ['empty text', 'channelId=', 'must be non-empty'],
    ['invalid interval', 'sinceMs=200&untilMs=100', 'less than or equal'],
    ['fractional time', 'sinceMs=1.5', 'safe integer'],
    ['invalid lane', 'lane=free', 'Invalid lane'],
    ['invalid surface', 'surface=paidMoney', 'Invalid surface'],
  ])('rejects %s', (_name, query, message) => {
    expect(parseChargeCostQuery(new URLSearchParams(query))).toEqual({
      ok: false,
      error: expect.stringContaining(message),
    });
  });
});
