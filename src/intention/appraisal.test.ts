import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../agent/contracts.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import { InternalStateComputer } from '../self-model/state.js';
import {
  IntentionAppraisal,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_FOLLOW_UP_AUTHOR_ID,
  INTENTION_FOLLOW_UP_AUTHOR_NAME,
  decisionsToPostTurnActionCandidates,
  normalizeIntentionFollowUpActionPayload,
  sessionEntriesToIntentionMessages,
  toInferredPostTurnActions,
  type IntentionActionDecision,
} from './appraisal.js';

function makeEmotionSnapshot(overrides?: Partial<EmotionStateSnapshot>): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0.5,
    ...overrides,
  };
}

function makeProvider(responses: string[]): { provider: LLMProvider; complete: ReturnType<typeof vi.fn> } {
  let index = 0;
  const complete = vi.fn(async () => {
    const fallback = responses.length > 0 ? responses[responses.length - 1] : '{"decisions":[{"type":"noop","priority":"low","reason":"default","timing":"none"}]}';
    const content = responses[index] ?? fallback;
    index += 1;
    return {
      content,
      toolCalls: [],
      model: 'test-model',
      inputTokens: 12,
      outputTokens: 22,
      stopReason: 'stop',
    };
  });
  return {
    provider: {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete,
    },
    complete,
  };
}

function makeInternalState() {
  return new InternalStateComputer().computeState({
    emotionState: makeEmotionSnapshot({
      vad: { valence: -0.3, arousal: 0.2, dominance: -0.1 },
      mood: { valence: -0.25, arousal: 0.18, dominance: -0.08 },
      discrete: { concern: 0.7 },
      confidence: 0.82,
    }),
    activeConcerns: [{
      id: 'concern-1',
      text: 'Follow up soon',
      priority: 'high',
      source: 'agent',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
      contactId: 'contact-primary',
    }],
    trustLevel: 'primary',
    contactId: 'contact-primary',
    sessionMetrics: {
      userMessageText: 'Can we revisit this tomorrow?',
      responseText: 'Absolutely, I can check in.',
      toolCallCount: 0,
      recentTurnCount: 4,
      lastSeenDeltaSeconds: 120,
    },
  });
}

describe('IntentionAppraisal', () => {
  it('runs on appraisal cadence and parses follow-up decisions', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'followUp',
          priority: 'high',
          reason: 'User asked for a check-in reminder.',
          timing: 'soon',
          followUp: {
            content: 'Quick check-in: how are you feeling after our last chat?',
          },
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 2,
      emotionalShiftThreshold: 0.95,
    });

    const first = await appraisal.evaluate({
      sessionId: 'api:test',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'Can we revisit this later?' }],
    });
    const second = await appraisal.evaluate({
      sessionId: 'api:test',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'Can we revisit this later?' }],
    });

    expect(first).toEqual([{
      type: 'noop',
      priority: 'low',
      reason: 'no appraisal trigger matched',
      timing: 'none',
    }]);
    expect(second[0]?.type).toBe('followUp');
    expect(second[0]?.followUp?.content).toContain('check-in');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1]).toBe('background');
  });

  it('triggers immediately on emotional shift', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'schedule',
          priority: 'medium',
          reason: 'Schedule an emotional reflection heartbeat.',
          timing: 'scheduled',
          schedule: {
            templateId: 'emotional-check',
          },
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 20,
      emotionalShiftThreshold: 0.2,
    });

    const first = await appraisal.evaluate({
      sessionId: 'api:emotion',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'Feeling neutral.' }],
    });
    const second = await appraisal.evaluate({
      sessionId: 'api:emotion',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.65, arousal: 0.1, dominance: -0.2 },
      }),
      recentMessages: [{ role: 'user', content: 'Actually I feel pretty stressed.' }],
    });

    expect(first[0]?.type).toBe('noop');
    expect(second[0]).toMatchObject({
      type: 'schedule',
      schedule: { templateId: 'emotional-check' },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('supports motivation trigger override to bypass cadence checks', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'followUp',
          priority: 'medium',
          reason: 'Sustained mood drift needs a check-in.',
          timing: 'soon',
          followUp: {
            content: 'Following up because the emotional trend stayed low.',
          },
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 20,
      emotionalShiftThreshold: 0.95,
    });

    const first = await appraisal.evaluate({
      sessionId: 'api:motivation',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'Just checking in.' }],
    });
    const second = await appraisal.evaluate({
      sessionId: 'api:motivation',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.12, arousal: 0.04, dominance: -0.08 },
      }),
      recentMessages: [{ role: 'user', content: 'Still feeling low energy.' }],
      triggerOverride: 'motivation',
      motivationSignals: ['sustained_negative_valence'],
    });

    expect(first[0]?.type).toBe('noop');
    expect(second[0]?.type).toBe('followUp');
    expect(complete).toHaveBeenCalledTimes(1);
    const promptPayload = JSON.parse((complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '{}') as string) as {
      trigger?: string;
      motivationSignals?: string[];
    };
    expect(promptPayload.trigger).toBe('motivation');
    expect(promptPayload.motivationSignals).toEqual(['sustained_negative_valence']);
  });

  it('serializes prompt timestamps as formatted active-timezone labels (no unix epoch)', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'noop',
          priority: 'low',
          reason: 'No action required',
          timing: 'none',
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 1,
      emotionalShiftThreshold: 1.5,
    });

    await appraisal.evaluate({
      sessionId: 'api:timestamp-format',
      currentEmotion: makeEmotionSnapshot(),
      activeConcerns: [{
        id: 'concern-1',
        title: 'Follow up tomorrow',
        dueAt: Date.parse('2026-03-11T14:00:00.000Z'),
      }],
      recentMessages: [{
        role: 'user',
        content: 'Can we pick this up tomorrow?',
        timestamp: Date.parse('2026-03-10T15:30:00.000Z'),
      }],
      now: Date.parse('2026-03-10T16:00:00.000Z'),
    });

    const promptBody = String(complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
    expect(promptBody).not.toContain('"timestamp":');

    const promptPayload = JSON.parse(promptBody) as {
      now?: unknown;
      timezone?: unknown;
      recentMessages?: Array<Record<string, unknown>>;
      activeConcerns?: Array<Record<string, unknown>>;
    };
    expect(typeof promptPayload.now).toBe('string');
    expect(String(promptPayload.now)).toMatch(/^\d{2}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z_/\-]+$/);
    expect(promptPayload.timezone).toBe('America/New_York');

    expect(promptPayload.recentMessages?.[0]?.at).toBeTypeOf('string');
    expect(promptPayload.recentMessages?.[0]?.timestamp).toBeUndefined();

    expect(promptPayload.activeConcerns?.[0]?.dueAt).toBeTypeOf('string');
  });

  it('includes recently resolved concerns in the appraisal prompt for dedupe context', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'noop',
          priority: 'low',
          reason: 'No action required',
          timing: 'none',
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 1,
      emotionalShiftThreshold: 1.5,
    });

    await appraisal.evaluate({
      sessionId: 'api:resolved-concerns',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'We already handled that cleanup task.' }],
      recentlyResolvedConcerns: [{
        id: 'resolved-1',
        title: 'Clean up the lingering profile reminder',
        summary: 'Handled during the current run',
        status: 'resolved',
        resolvedAt: Date.parse('2026-03-10T15:45:00.000Z'),
        priority: 'medium',
      }],
    });

    const promptPayload = JSON.parse((complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '{}') as string) as {
      recentlyResolvedConcerns?: Array<Record<string, unknown>>;
    };
    expect(promptPayload.recentlyResolvedConcerns?.[0]).toMatchObject({
      id: 'resolved-1',
      title: 'Clean up the lingering profile reminder',
      status: 'resolved',
      summary: 'Handled during the current run',
      priority: 'medium',
    });
    expect(promptPayload.recentlyResolvedConcerns?.[0]?.resolvedAt).toBeTypeOf('string');
  });

  it('fails closed when model output is malformed', async () => {
    const { provider } = makeProvider(['not valid json']);
    const onEvaluationError = vi.fn();
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 1,
      emotionalShiftThreshold: 1.5,
      onEvaluationError,
    });

    const decisions = await appraisal.evaluate({
      sessionId: 'api:fail-closed',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'Do something proactive.' }],
    });

    expect(decisions).toEqual([{
      type: 'noop',
      priority: 'low',
      reason: 'appraisal failed closed',
      timing: 'none',
    }]);
    expect(onEvaluationError).toHaveBeenCalledTimes(1);
  });

  it('uses InternalState as primary appraisal input when provided', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'followUp',
          priority: 'medium',
          reason: 'Needs proactive support.',
          timing: 'soon',
          followUp: {
            content: 'Checking in after your recent stress signals.',
          },
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 1,
      emotionalShiftThreshold: 1.5,
    });

    const decisions = await appraisal.evaluate({
      sessionId: 'api:internal-state',
      internalState: makeInternalState(),
      recentMessages: [{ role: 'user', content: 'I still feel off today.' }],
    });

    expect(decisions[0]?.type).toBe('followUp');
    const promptPayload = JSON.parse((complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '{}') as string) as {
      internalState?: unknown;
      currentEmotion?: unknown;
    };
    expect(promptPayload.internalState).toBeDefined();
    expect(promptPayload.currentEmotion).toBeDefined();
  });

  it('loads persona context for Whisper notes and renders character macros before appraisal', async () => {
    const { provider, complete } = makeProvider([
      JSON.stringify({
        decisions: [{
          type: 'followUp',
          priority: 'medium',
          reason: 'Needs an internal nudge.',
          timing: 'soon',
          followUp: {
            content: 'Note to self: keep the tone gentle and direct.',
          },
        }],
      }),
    ]);
    const appraisal = new IntentionAppraisal({
      llmProvider: provider,
      appraisalFrequency: 1,
      emotionalShiftThreshold: 1.5,
      characterPromptVariablesProvider: () => ({
        char_name: 'RuntimeCompanion',
        description: '{{char}} helps {{user}} untangle confusing bugs.',
        personality: 'Warm, analytical, and quietly steady.',
        'character.visual_description': 'Silver eyes and a weathered jacket.',
      }),
    });

    await appraisal.evaluate({
      sessionId: 'api:persona',
      currentEmotion: makeEmotionSnapshot(),
      recentMessages: [{ role: 'user', content: 'I am frustrated with this bug.' }],
    });

    const promptBody = String(complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
    const promptPayload = JSON.parse(promptBody) as {
      persona?: {
        name?: string;
        description?: string;
        personality?: string;
        visualDescription?: string;
      };
    };
    expect(promptPayload.persona).toMatchObject({
      name: 'RuntimeCompanion',
      description: 'RuntimeCompanion helps the user untangle confusing bugs.',
      personality: 'Warm, analytical, and quietly steady.',
      visualDescription: 'Silver eyes and a weathered jacket.',
    });
    expect(String(complete.mock.calls[0]?.[0]?.systemPrompt ?? '')).toContain('Whisper notes to self');
  });
});

describe('intention appraisal action mapping', () => {
  it('maps actionable decisions into inferred post-turn actions', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const decisions: IntentionActionDecision[] = [{
        type: 'followUp',
        priority: 'high',
        reason: 'Needs proactive support.',
        timing: 'soon',
        dueAt: 1_700_000_460_000,
        followUp: {
          content: 'Checking in after our last conversation.',
        },
      }, {
        type: 'schedule',
        priority: 'medium',
        reason: 'Run structured check-in template later.',
        timing: 'scheduled',
        schedule: {
          templateId: 'emotional-check',
        },
      }, {
        type: 'concern',
        priority: 'medium',
        reason: 'Track recurring stressor.',
        timing: 'soon',
        concern: {
          title: 'Watch stress trend',
        },
      }];

      const candidates = decisionsToPostTurnActionCandidates(decisions, {
        message: {
          id: 'msg-intention-1',
          channelId: 'api:test',
          channelType: 'api',
        },
      });
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.kind).toBe(INTENTION_FOLLOW_UP_ACTION_KIND);
      expect(candidates[0]?.runAt).toBe(1_700_000_460_000);
      expect(candidates[1]).toMatchObject({
        kind: 'heartbeat.run_template',
        payload: { templateId: 'emotional-check' },
      });

      const inferred = toInferredPostTurnActions(candidates, {
        id: 'msg-intention-1',
        channelId: 'api:test',
      });
      expect(inferred).toHaveLength(2);
      expect(normalizeIntentionFollowUpActionPayload(inferred[0]?.payload)).toMatchObject({
        channelId: 'api:test',
        channelType: 'api',
        authorId: INTENTION_FOLLOW_UP_AUTHOR_ID,
        authorName: INTENTION_FOLLOW_UP_AUTHOR_NAME,
        content: 'Checking in after our last conversation.',
      });
      expect(inferred[0]?.runAt).toBe(1_700_000_460_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('delays soon follow-ups without explicit dueAt before surfacing them', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_500_000);

      const candidates = decisionsToPostTurnActionCandidates([{
        type: 'followUp',
        priority: 'medium',
        reason: 'Needs a check-in but not right this second.',
        timing: 'soon',
        followUp: {
          content: 'Checking in a little later.',
        },
      }], {
        message: {
          id: 'msg-intention-3',
          channelId: 'api:test',
          channelType: 'api',
        },
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe(INTENTION_FOLLOW_UP_ACTION_KIND);
      expect(candidates[0]?.runAt).toBe(1_700_000_800_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('surfaces pending follow-ups immediately during explicit proactive rechecks', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_500_000);

      const candidates = decisionsToPostTurnActionCandidates([{
        type: 'followUp',
        priority: 'medium',
        reason: 'Needs an explicit recheck.',
        timing: 'soon',
        followUp: {
          content: 'Checking in now because I rechecked the situation.',
        },
      }], {
        message: {
          id: 'msg-intention-4',
          channelId: 'api:test',
          channelType: 'api',
        },
      }, {
        surfacePendingFollowUpsImmediately: true,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe(INTENTION_FOLLOW_UP_ACTION_KIND);
      expect(candidates[0]?.runAt).toBe(1_700_000_500_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('forces intention follow-ups to system attribution even if the model supplies user authors', () => {
    const candidates = decisionsToPostTurnActionCandidates([{
      type: 'followUp',
      priority: 'medium',
      reason: 'Needs a check-in.',
      timing: 'soon',
      followUp: {
        content: 'Checking in.',
        authorId: 'user-1',
        authorName: 'PrimaryUser',
      },
    }], {
      message: {
        id: 'msg-intention-2',
        channelId: 'discord:test',
        channelType: 'discord',
      },
    });

    expect(normalizeIntentionFollowUpActionPayload(candidates[0]?.payload)).toMatchObject({
      channelId: 'discord:test',
      channelType: 'discord',
      authorId: INTENTION_FOLLOW_UP_AUTHOR_ID,
      authorName: INTENTION_FOLLOW_UP_AUTHOR_NAME,
      content: 'Checking in.',
    });
  });
});

describe('sessionEntriesToIntentionMessages', () => {
  it('drops leaked intention artifacts from appraisal history', () => {
    const messages = sessionEntriesToIntentionMessages([{
      role: 'user',
      content: '[Intention Appraisal] I am investigating the logs.',
      timestamp: 1_700_000_000_000,
      authorId: 'user-1',
      authorName: 'Intention Appraisal',
      channelId: 'discord:test',
      metadata: JSON.stringify({
        turn: {
          schemaVersion: 1,
          turnId: 'turn-1',
          requestId: 'intention-follow-up:abc123',
          sourceMessageId: 'intention-follow-up:abc123',
          role: 'user',
        },
      }),
    }, {
      role: 'user',
      content: 'This is the real partner message.',
      timestamp: 1_700_000_000_100,
      authorId: 'user-1',
      authorName: 'PrimaryUser',
      channelId: 'discord:test',
    }]);

    expect(messages).toEqual([{
      role: 'user',
      content: 'This is the real partner message.',
      timestamp: 1_700_000_000_100,
    }]);
  });
});
