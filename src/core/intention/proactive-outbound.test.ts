import { describe, expect, it, vi } from 'vitest';
import { ProactiveOutboundDispatcher } from './proactive-outbound.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import {
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  type IntentionActionDecision,
} from './appraisal/types.js';
import {
  decisionsToPostTurnActionCandidates,
  normalizeIntentionOutboundMessageActionPayload,
} from './appraisal/action-translation.js';

const PRIMARY_DM_CHANNEL = '123456789012345678';

function makeDispatcher(overrides: {
  send?: ReturnType<typeof vi.fn>;
  approved?: (channelId: string) => boolean;
  rateLimiter?: ExternalCommunicationRateLimiter;
} = {}) {
  const send = overrides.send ?? vi.fn(async () => {});
  const dispatcher = new ProactiveOutboundDispatcher({
    sender: { send },
    rateLimiter: overrides.rateLimiter ?? new ExternalCommunicationRateLimiter(),
    isApprovedPrimaryChannel: overrides.approved ?? ((channelId) => channelId === PRIMARY_DM_CHANNEL),
  });
  return { dispatcher, send };
}

describe('ProactiveOutboundDispatcher', () => {
  it('sends to the approved primary private channel', async () => {
    const { dispatcher, send } = makeDispatcher();
    const result = await dispatcher.dispatch({
      actionId: 'a1',
      channelId: PRIMARY_DM_CHANNEL,
      channelType: 'discord',
      content: 'hey — thinking of you, did you eat?',
    });
    expect(result).toEqual({ outcome: 'sent' });
    expect(send).toHaveBeenCalledWith(PRIMARY_DM_CHANNEL, 'hey — thinking of you, did you eat?');
  });

  it('blocks non-discord channel types', async () => {
    const { dispatcher, send } = makeDispatcher();
    const result = await dispatcher.dispatch({
      actionId: 'a2',
      channelId: PRIMARY_DM_CHANNEL,
      channelType: 'telegram',
      content: 'hello',
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'unsupported_channel_type' });
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks channels not approved for the primary contact', async () => {
    const { dispatcher, send } = makeDispatcher();
    const result = await dispatcher.dispatch({
      actionId: 'a3',
      channelId: '999999999999999999',
      channelType: 'discord',
      content: 'hello',
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'channel_not_approved_for_primary' });
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks empty content and rate-limited sends', async () => {
    const limiter = new ExternalCommunicationRateLimiter({ discordPerHour: 1 });
    const { dispatcher, send } = makeDispatcher({ rateLimiter: limiter });

    expect(await dispatcher.dispatch({
      actionId: 'a4',
      channelId: PRIMARY_DM_CHANNEL,
      channelType: 'discord',
      content: '   ',
    })).toEqual({ outcome: 'blocked', reason: 'empty_content' });

    expect((await dispatcher.dispatch({
      actionId: 'a5',
      channelId: PRIMARY_DM_CHANNEL,
      channelType: 'discord',
      content: 'first',
    })).outcome).toBe('sent');
    expect(await dispatcher.dispatch({
      actionId: 'a6',
      channelId: PRIMARY_DM_CHANNEL,
      channelType: 'discord',
      content: 'second within the hour',
    })).toMatchObject({ outcome: 'blocked', reason: 'rate_limited' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('external follow-up translation', () => {
  const context = {
    message: { id: 'msg-1', channelId: PRIMARY_DM_CHANNEL, channelType: 'discord' as const },
  };

  it('routes delivery:external follow-ups to the outbound action kind', () => {
    const decisions: IntentionActionDecision[] = [{
      type: 'followUp',
      priority: 'medium',
      reason: 'checking in after a long quiet stretch',
      timing: 'immediate',
      followUp: {
        content: 'hey, you went quiet — everything okay?',
        delivery: 'external',
      },
    }];
    const candidates = decisionsToPostTurnActionCandidates(decisions, context);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
    const payload = normalizeIntentionOutboundMessageActionPayload(candidates[0].payload);
    expect(payload?.content).toBe('hey, you went quiet — everything okay?');
    expect(payload?.channelId).toBe(PRIMARY_DM_CHANNEL);
    expect(payload?.reason).toBe('checking in after a long quiet stretch');
  });

  it('time-gates external follow-ups behind future concern boundaries and quiet hours', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(Date.parse('2026-06-15T18:00:00.000Z'));
      const decisions: IntentionActionDecision[] = [{
        type: 'followUp',
        priority: 'high',
        reason: 'User asked for a doctor reminder tomorrow.',
        timing: 'immediate',
        followUp: {
          content: 'Remember to contact the doctor.',
          delivery: 'external',
        },
      }];

      const candidates = decisionsToPostTurnActionCandidates(decisions, context, {
        minimumOutboundRunAt: Date.parse('2026-06-16T00:00:00.000Z'),
        proactiveOutboundQuietHours: {
          enabled: true,
          startLocalTime: '00:00',
          endLocalTime: '08:00',
          timeZone: 'UTC',
        },
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
      expect(candidates[0]?.runAt).toBe(Date.parse('2026-06-16T08:00:00.000Z'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps default follow-ups on the internal whisper path', () => {
    const decisions: IntentionActionDecision[] = [{
      type: 'followUp',
      priority: 'low',
      reason: 'note to self',
      timing: 'immediate',
      followUp: { content: 'remember to ask about the trip' },
    }];
    const candidates = decisionsToPostTurnActionCandidates(decisions, context);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('intention.follow_up');
  });

  it('rejects malformed outbound payloads', () => {
    expect(normalizeIntentionOutboundMessageActionPayload({ channelId: '', channelType: 'discord', content: 'x' })).toBeNull();
    expect(normalizeIntentionOutboundMessageActionPayload({ channelId: 'c', channelType: 'bogus', content: 'x' })).toBeNull();
    expect(normalizeIntentionOutboundMessageActionPayload({ channelId: 'c', channelType: 'discord', content: '  ' })).toBeNull();
  });
});
