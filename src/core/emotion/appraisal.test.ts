import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { CompletionPurpose, LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import { EmotionAppraisal } from './appraisal.js';
import type { EmotionStateSnapshot } from './state.js';
import { InternalStateComputer } from '../self-model/state.js';

function makeSnapshot(
  overrides?: Partial<EmotionStateSnapshot>,
): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0.5,
    ...overrides,
  };
}

function makeMockProvider(responses: string[]): { provider: LLMProviderPort; complete: ReturnType<typeof vi.fn> } {
  let index = 0;
  const complete = vi.fn(async (
    _context: LLMContext,
    _purpose: CompletionPurpose,
  ) => {
    const fallback = responses.length > 0 ? responses[responses.length - 1] : 'default appraisal';
    const content = responses[index] ?? fallback;
    index += 1;
    return {
      content,
      toolCalls: [],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse;
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
    emotionState: makeSnapshot({
      vad: { valence: 0.2, arousal: 0.3, dominance: 0.1 },
      mood: { valence: 0.15, arousal: 0.25, dominance: 0.08 },
      discrete: { joy: 0.7, trust: 0.6 },
      confidence: 0.8,
    }),
    activeConcerns: [{
      id: 'concern-1',
      text: 'Follow up with user',
      priority: 'high',
      source: 'agent',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
    }],
    trustLevel: 'trusted',
    contactId: 'contact-1',
    sessionMetrics: {
      userMessageText: 'hello',
      responseText: 'I can help with that.',
      toolCallCount: 0,
      recentTurnCount: 3,
      lastSeenDeltaSeconds: 120,
    },
  });
}

describe('EmotionAppraisal', () => {
  it('triggers periodic appraisal at configured turn cadence', async () => {
    const { provider, complete } = makeMockProvider(['Periodic appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 2,
      vadDeltaThreshold: 0.9,
    });

    const first = await appraisal.maybeAppraise({
      sessionId: 'session-a',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
      }),
      recentMessages: [{ role: 'user', content: 'hello' }],
      personalityTraits: { 'character.personality': 'steady and warm' },
    });
    const second = await appraisal.maybeAppraise({
      sessionId: 'session-a',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
      }),
      recentMessages: [{ role: 'user', content: 'hello again' }],
      personalityTraits: { 'character.personality': 'steady and warm' },
    });

    expect(first.appraised).toBe(false);
    expect(second.appraised).toBe(true);
    expect(second.trigger).toBe('periodic');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1]).toBe('background');
    expect(appraisal.getChain('session-a')).toHaveLength(1);
  });

  it('emits a typed appraisal gate event on skip and on run (jpvd.4)', async () => {
    const { provider } = makeMockProvider(['Periodic appraisal summary']);
    const events: Array<{ outcome: string; reason: string; inputs: Record<string, number | string> }> = [];
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 2,
      vadDeltaThreshold: 0.9,
      onGateEvent: (event) => events.push({
        outcome: event.outcome,
        reason: event.reason,
        inputs: event.inputs,
      }),
    });
    const snapshot = () => makeSnapshot({ vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 } });

    await appraisal.maybeAppraise({
      sessionId: 'session-g',
      currentEmotion: snapshot(),
      recentMessages: [{ role: 'user', content: 'hi' }],
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-g',
      currentEmotion: snapshot(),
      recentMessages: [{ role: 'user', content: 'hi again' }],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ outcome: 'skipped', reason: 'no_movement' });
    expect(events[0].inputs.turnsSinceLast).toBe(1);
    expect(events[1]).toMatchObject({ outcome: 'ran', reason: 'periodic' });
    expect(events[1].inputs.turnsSinceLast).toBe(2);
  });

  it('triggers appraisal immediately on significant VAD shift', async () => {
    const { provider } = makeMockProvider(['Shift appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 10,
      vadDeltaThreshold: 0.2,
    });

    const first = await appraisal.maybeAppraise({
      sessionId: 'session-shift',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'neutral' }],
    });
    const second = await appraisal.maybeAppraise({
      sessionId: 'session-shift',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.45, arousal: 0.1, dominance: 0 },
      }),
      recentMessages: [{ role: 'user', content: 'I am upset now' }],
    });

    expect(first.appraised).toBe(false);
    expect(second.appraised).toBe(true);
    expect(second.trigger).toBe('vad_shift');
    expect(second.delta).toBeGreaterThanOrEqual(0.45);
  });

  it('bounds prompt history input and trims chain length', async () => {
    const { provider, complete } = makeMockProvider([
      'first summary',
      'second summary',
      'third summary',
    ]);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 1,
      vadDeltaThreshold: 1.5,
      recentMessageCount: 2,
      maxChainEntries: 2,
    });

    const recentMessages = [
      { role: 'user' as const, content: 'old context line' },
      { role: 'assistant' as const, content: 'middle context line' },
      { role: 'user' as const, content: 'new context line' },
    ];

    await appraisal.maybeAppraise({
      sessionId: 'session-bounded',
      currentEmotion: makeSnapshot(),
      recentMessages,
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-bounded',
      currentEmotion: makeSnapshot(),
      recentMessages,
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-bounded',
      currentEmotion: makeSnapshot(),
      recentMessages,
    });

    const firstPrompt = complete.mock.calls[0]?.[0].messages[0]?.content as string;
    expect(firstPrompt).toContain('middle context line');
    expect(firstPrompt).toContain('new context line');
    expect(firstPrompt).not.toContain('old context line');

    const chain = appraisal.getChain('session-bounded');
    expect(chain).toHaveLength(2);
    expect(chain.map(entry => entry.summary)).toEqual(['second summary', 'third summary']);
  });

  it('fails closed when background model returns empty appraisal text', async () => {
    const { provider } = makeMockProvider(['   ']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 1,
      vadDeltaThreshold: 1.5,
    });

    await expect(appraisal.maybeAppraise({
      sessionId: 'session-empty',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow('non-empty');
  });

  it('accepts InternalState input as the primary appraisal signal', async () => {
    const { provider, complete } = makeMockProvider(['Internal-state appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      turnCadence: 1,
      vadDeltaThreshold: 1.5,
    });

    const result = await appraisal.maybeAppraise({
      sessionId: 'session-internal-state',
      internalState: makeInternalState(),
      recentMessages: [{ role: 'user', content: 'How am I doing?' }],
    });

    expect(result.appraised).toBe(true);
    const prompt = complete.mock.calls[0]?.[0].messages[0]?.content as string;
    expect(prompt).toContain('[Internal State Signals]');
    expect(prompt).toContain('Cognitive: certainty=');
  });
});
