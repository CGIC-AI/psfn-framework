import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../core/session/types.js';
import { reconcileIcpAppraisalFailureClosures } from './icp-appraisal-failure-reconciliation.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DM = `companion-dm:${A}:${B}`;
const NOW = 1_790_340_000_000;

function observation(input: {
  sourceMessageId: string;
  conversationId: string;
  reason: string;
  turnId: string;
}): SessionEntry {
  const correlation = {
    conversationId: input.conversationId,
    rootInitiationId: '33333333-3333-4333-8333-333333333333',
    initiatedByCompanionId: A,
    localCompanionId: B,
    peerCompanionId: A,
    peerContactId: 'contact-a',
    channelId: DM,
    turnId: input.turnId,
    messageId: input.sourceMessageId,
    requestId: input.sourceMessageId,
    chargeLane: 'interactive',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'reply',
    fatigueDecision: 'not_evaluated',
  };
  return {
    role: 'system',
    timestamp: NOW - 60_000,
    content: JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: DM,
      sourceMessageId: input.sourceMessageId,
      status: 'suppressed',
      recoveryResponse: {
        content: '',
        channelId: DM,
        metadata: {
          model: 'participation-appraiser',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 64,
          turnId: input.turnId,
          requestId: input.sourceMessageId,
          icpCorrelation: correlation,
          noReply: {
            schemaVersion: 1,
            disposition: 'intentional_no_reply',
            source: 'participation_appraiser',
            auditId: `no-reply:${input.turnId}:participation-appraiser`,
            decidedAt: NOW - 60_000,
            turnId: input.turnId,
            requestId: input.sourceMessageId,
            channelId: DM,
            reason: input.reason,
          },
        },
      },
    }),
  } as unknown as SessionEntry;
}

describe('reconcileIcpAppraisalFailureClosures', () => {
  it('re-records only this companion\'s fail-closed appraisal closures inside the window', async () => {
    const entries = [
      observation({
        sourceMessageId: 'companion-initiation-a',
        conversationId: '44444444-4444-4444-8444-444444444441',
        reason: 'appraiser_timeout',
        turnId: '01a0d000-0000-7000-8000-000000000001',
      }),
      observation({
        sourceMessageId: 'companion-initiation-b',
        conversationId: '44444444-4444-4444-8444-444444444442',
        reason: 'exchange_complete_no_question',
        turnId: '01a0d000-0000-7000-8000-000000000002',
      }),
      { role: 'user', timestamp: NOW, content: 'hello' } as unknown as SessionEntry,
    ];
    const endEpisodeActivity = vi.fn(async () => ({}));

    const result = await reconcileIcpAppraisalFailureClosures({
      sessions: {
        listRecentSessions: () => [
          { channelId: DM, lastActivityAt: NOW, messageCount: entries.length },
          { channelId: 'api:someone', lastActivityAt: NOW, messageCount: 1 },
        ],
        getRecentSessionEntries: (channelId) => channelId === DM ? entries : [],
      },
      endEpisodeActivity,
      windowMs: 48 * 60 * 60_000,
      nowMs: NOW,
    });

    expect(endEpisodeActivity).toHaveBeenCalledTimes(1);
    expect(endEpisodeActivity).toHaveBeenCalledWith({
      conversationId: '44444444-4444-4444-8444-444444444441',
      reasonCode: 'peer_appraisal_unavailable',
    });
    expect(result).toEqual({ scannedChannels: 1, conversations: 1, failed: 0 });
  });

  it('reports a gateway refusal instead of hiding it and continues', async () => {
    const endEpisodeActivity = vi.fn(async () => {
      throw new Error('ICP conversation close-reason reclassification conflict');
    });
    const result = await reconcileIcpAppraisalFailureClosures({
      sessions: {
        listRecentSessions: () => [{ channelId: DM, lastActivityAt: NOW, messageCount: 1 }],
        getRecentSessionEntries: () => [observation({
          sourceMessageId: 'companion-initiation-c',
          conversationId: '44444444-4444-4444-8444-444444444443',
          reason: 'appraiser_unparseable',
          turnId: '01a0d000-0000-7000-8000-000000000003',
        })],
      },
      endEpisodeActivity,
      windowMs: 48 * 60 * 60_000,
      nowMs: NOW,
    });
    expect(result).toEqual({ scannedChannels: 1, conversations: 1, failed: 1 });
  });
});
