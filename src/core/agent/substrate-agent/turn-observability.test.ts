import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { TurnID } from '../../turns/types.js';
import { buildTurnCorrelation } from './turn-observability.js';

describe('buildTurnCorrelation', () => {
  it('binds channel, session, and worker attribution without message content', () => {
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: 'shard:shard-1',
      channelType: 'api',
      authorId: 'author-1',
      authorName: 'Author',
      content: 'private message body',
      timestamp: new Date(1_752_500_000_000),
      routing: { wyoming: { sessionId: 'session-1' } },
    };

    const correlation = buildTurnCorrelation(
      message,
      'tool',
      'turn-1' as TurnID,
      'request-1',
    );

    expect(correlation).toMatchObject({
      sessionId: 'session-1',
      requestId: 'request-1',
      channelId: 'shard:shard-1',
      channelType: 'api',
      callType: 'tool',
      purpose: 'agent.turn',
      service: 'agent',
      process: 'substrate-agent',
      shardId: 'shard-1',
      workloadType: 'shard',
      workloadId: 'shard-1',
    });
    expect(JSON.stringify(correlation)).not.toContain(message.content);
  });
});
