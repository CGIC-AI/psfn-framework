import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { TurnID } from '../../turns/types.js';
import { buildTurnCorrelation } from './turn-observability.js';
import { resolvePromptCacheAffinity } from '../../../primitives/llm/client-prompt-cache.js';

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
      { sessionId: 'session-1', rootInitiationId: 'root-1' },
    );

    expect(correlation).toMatchObject({
      sessionId: 'session-1',
      requestId: 'request-1',
      channelId: 'shard:shard-1',
      channelType: 'api',
      callType: 'tool',
      purpose: 'agent.turn',
      runtimeLaneClass: 'foreground_chat',
      service: 'agent',
      process: 'substrate-agent',
      conversationId: 'session-1',
      rootInitiationId: 'root-1',
      shardId: 'shard-1',
      workloadType: 'shard',
      workloadId: 'shard-1',
    });
    expect(JSON.stringify(correlation)).not.toContain(message.content);
  });

  it('uses the durable ICP episode identity instead of the ordinary session lineage', () => {
    const icpCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'message-1',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      fatigueDecision: 'allow' as const,
    };
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: icpCorrelation.channelId,
      channelType: 'companion',
      authorId: icpCorrelation.peerCompanionId,
      authorName: 'Peer',
      content: 'private message body',
      timestamp: new Date(1_752_500_000_000),
      routing: { icpCorrelation },
    };

    expect(buildTurnCorrelation(
      message,
      'chat',
      icpCorrelation.turnId as TurnID,
      icpCorrelation.requestId,
      { sessionId: 'ordinary-channel-session', rootInitiationId: 'charge-run-root' },
    )).toMatchObject({
      sessionId: 'ordinary-channel-session',
      companionId: icpCorrelation.localCompanionId,
      conversationId: icpCorrelation.conversationId,
      rootInitiationId: icpCorrelation.rootInitiationId,
      chargeLane: 'companion_social',
      icpCorrelation,
    });
  });

  it('carries the configured companion as a fallback scope on ordinary human ingress', () => {
    // Plain human DM: no icpCorrelation. Without the fallback the correlation
    // would carry no companionId and prompt-cache affinity would fail closed.
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: 'discord:dm:alice',
      channelType: 'discord',
      authorId: 'author-alice',
      authorName: 'Alice',
      content: 'hello',
      timestamp: new Date(1_752_500_000_000),
    };
    const correlation = buildTurnCorrelation(
      message,
      'chat',
      'turn-1' as TurnID,
      'request-1',
      { sessionId: 'session-1', rootInitiationId: 'root-1' },
      'companion-companion',
    );
    expect(correlation.companionId).toBe('companion-companion');
    expect(correlation.icpCorrelation).toBeUndefined();

    // The correlation now yields a session-keyed affinity token (no longer
    // missing_companion_id) bound to the configured companion.
    const affinity = resolvePromptCacheAffinity('channel', correlation);
    expect('sessionId' in affinity).toBe(true);
  });

  it('lets the ICP local companion win over the configured fallback', () => {
    const icpCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:a:b',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'message-1',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      fatigueDecision: 'allow' as const,
    };
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: icpCorrelation.channelId,
      channelType: 'companion',
      authorId: icpCorrelation.peerCompanionId,
      authorName: 'Peer',
      content: 'hi',
      timestamp: new Date(1_752_500_000_000),
      routing: { icpCorrelation },
    };
    const correlation = buildTurnCorrelation(
      message,
      'chat',
      icpCorrelation.turnId as TurnID,
      icpCorrelation.requestId,
      { sessionId: 'session-1', rootInitiationId: 'root-1' },
      'configured-fallback-companion',
    );
    expect(correlation.companionId).toBe(icpCorrelation.localCompanionId);
  });

  it('gives two companions distinct affinity tokens on byte-identical channel/session inputs', () => {
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: 'discord:guild-42:general',
      channelType: 'discord',
      authorId: 'author-alice',
      authorName: 'Alice',
      content: 'hello',
      timestamp: new Date(1_752_500_000_000),
    };
    const build = (companionId: string) =>
      buildTurnCorrelation(
        message,
        'chat',
        'turn-1' as TurnID,
        'request-1',
        { sessionId: 'session-1', rootInitiationId: 'root-1' },
        companionId,
      );
    const tokenA = resolvePromptCacheAffinity('channel', build('companion-a'));
    const tokenB = resolvePromptCacheAffinity('channel', build('companion-b'));
    if (!('sessionId' in tokenA) || !('sessionId' in tokenB)) {
      throw new Error('expected affinity tokens for both companions');
    }
    expect(tokenA.sessionId).not.toBe(tokenB.sessionId);
  });
});
