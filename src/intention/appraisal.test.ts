import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../agent/contracts.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import {
  IntentionAppraisal,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  decisionsToPostTurnActionCandidates,
  normalizeIntentionFollowUpActionPayload,
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
});

describe('intention appraisal action mapping', () => {
  it('maps actionable decisions into inferred post-turn actions', () => {
    const decisions: IntentionActionDecision[] = [{
      type: 'followUp',
      priority: 'high',
      reason: 'Needs proactive support.',
      timing: 'soon',
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
      content: 'Checking in after our last conversation.',
    });
  });
});
