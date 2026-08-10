import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { IntakeReleaseRedeliveryInput } from '../../operator/garden/services/intake-quarantine-service.js';
import { createIntakeReleaseConversationTurn } from './intake-release-conversation-turn.js';

function releaseInput(
  sourceClass: IntakeReleaseRedeliveryInput['envelope']['sourceClass'] = 'primary_user',
): IntakeReleaseRedeliveryInput {
  return {
    envelope: {
      schemaVersion: 1,
      id: 'release-envelope-1',
      sourceClass,
      sourceRiskTier: 'trusted',
      provenance: [{
        kind: sourceClass,
        ref: 'discord:123456789012345678:987654321098765432',
        atMs: 1_786_392_603_970,
      }],
      contentRef: { kind: 'inline', sha256: 'a'.repeat(64), sizeBytes: 24 },
      extractedFields: {},
      riskLabels: ['injection/override_attempt'],
      scores: {},
      decision: { action: 'release_raw', reason: 'operator_review' },
      state: 'human_released',
      createdAtMs: 1_786_392_603_970,
      transitions: [],
    },
    mode: 'enforce',
    action: 'release_raw',
    actor: 'operator:garden',
    atMs: 1_786_392_643_573,
    content: 'the exact released body',
    rawTextTruncated: false,
    sourceChannelId: '123456789012345678',
    canonicalContactId: 'contact-primary',
  };
}

function response(): AgentResponse {
  return {
    content: 'I can see the released context now.',
    channelId: '123456789012345678',
    metadata: {
      model: 'test/model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

describe('intake release canonical conversation turn', () => {
  it('runs a firewall-authored system turn and delivers the companion response', async () => {
    const entries: SessionEntry[] = [];
    const sendText = vi.fn(async () => {});
    const handleMessage = vi.fn(async (message: SubstrateMessage) => {
      entries.push({
        id: 41,
        channelId: 'logical-session-1',
        role: 'system',
        content: message.content,
        authorId: message.authorId,
        authorName: message.authorName,
        timestamp: message.timestamp.getTime(),
        metadata: JSON.stringify({
          turn: { sourceMessageId: message.id },
          intakeScreening: { envelopes: message.routing?.intakeEnvelopes },
        }),
      });
      return response();
    });
    const place = createIntakeReleaseConversationTurn({
      agent: { handleMessage },
      delivery: { sendText, sendMedia: vi.fn(async () => {}) },
      sessions: {
        resolveSessionForIngress: () => 'logical-session-1',
        findRecordedSourceMessageEntry: (_channelId, sourceMessageId) => entries.find(
          entry => entry.metadata?.includes(sourceMessageId),
        ) ?? null,
      },
      classifyChannelPrivacy: () => 'private',
    });

    const result = await place(releaseInput());

    expect(result).toEqual({
      delivered: true,
      channelId: '123456789012345678',
      logicalSessionId: 'logical-session-1',
      entryId: 41,
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const message = handleMessage.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      channelId: '123456789012345678',
      channelType: 'discord',
      authorId: 'system:intake-firewall',
      authorName: 'Intake firewall',
      routing: { channelPrivacy: 'private' },
    });
    expect(message?.content).toContain('the exact released body');
    expect(message?.routing?.intakeEnvelopes).toEqual([
      expect.objectContaining({
        envelopeId: 'release-envelope-1',
        sourceClass: 'primary_user',
        state: 'human_released',
      }),
    ]);
    expect(message?.authorId).not.toBe('contact-primary');
    expect(sendText).toHaveBeenCalledWith(
      '123456789012345678',
      'I can see the released context now.',
    );
  });

  it('keeps released tool output system-authored instead of impersonating a person', async () => {
    let recorded: SessionEntry | null = null;
    const handleMessage = vi.fn(async (message: SubstrateMessage) => {
      recorded = {
        id: 9,
        channelId: 'logical-session-1',
        role: 'system',
        content: message.content,
        authorId: message.authorId,
        authorName: message.authorName,
        timestamp: message.timestamp.getTime(),
        metadata: JSON.stringify({ turn: { sourceMessageId: message.id } }),
      };
      return { ...response(), content: '' };
    });
    const place = createIntakeReleaseConversationTurn({
      agent: { handleMessage },
      delivery: { sendText: vi.fn(async () => {}), sendMedia: vi.fn(async () => {}) },
      sessions: {
        resolveSessionForIngress: () => 'logical-session-1',
        findRecordedSourceMessageEntry: () => recorded,
      },
      classifyChannelPrivacy: () => 'private',
    });

    const result = await place(releaseInput('tool_output'));

    expect(result.delivered).toBe(true);
    expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
      authorId: 'system:intake-firewall',
      authorName: 'Intake firewall',
    });
  });
});
