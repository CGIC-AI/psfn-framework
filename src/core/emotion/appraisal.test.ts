import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { CompletionPurpose, LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import { EmotionAppraisal } from './appraisal.js';
import { projectEmotionAppraisalState } from './appraisal-state.js';
import { parseNarrativeAppraisalDriftDecision } from './narrative-appraisal-drift.js';
import type { EmotionStateSnapshot } from './state.js';
import { InternalStateComputer } from '../self-model/state.js';
import {
  buildSystemPromptCacheBoundaries,
  verifySystemPromptCacheBoundaries,
} from '../../primitives/llm/prompt-cache.js';

const TEST_NOW_MS = 1_780_000_000_000;

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
  it('never appraises stable state merely because more turns elapsed', async () => {
    const { provider, complete } = makeMockProvider(['Unexpected periodic appraisal']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
    });

    const results = [];
    for (let turn = 0; turn < 6; turn += 1) {
      results.push(await appraisal.maybeAppraise({
        sessionId: 'session-a',
        currentEmotion: makeSnapshot({
          vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
        }),
        recentMessages: [{ role: 'user', content: `stable turn ${turn}` }],
      }));
    }

    expect(results.every(result => result.appraised === false)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(appraisal.getChain('session-a')).toHaveLength(0);
  });

  it('emits a typed appraisal gate event on skip and on run (jpvd.4)', async () => {
    const { provider } = makeMockProvider(['Drift appraisal summary']);
    const events: Array<{ outcome: string; reason: string; inputs: Record<string, number | string> }> = [];
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
      onGateEvent: (event) => events.push({
        outcome: event.outcome,
        reason: event.reason,
        inputs: event.inputs,
      }),
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-g',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
      }),
      recentMessages: [{ role: 'user', content: 'hi' }],
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-g',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.5, arousal: 0.1, dominance: 0.1 },
      }),
      recentMessages: [{ role: 'user', content: 'hi again' }],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ outcome: 'skipped', reason: 'baseline_seeded' });
    expect(events[0].inputs.turnsSinceLast).toBe(1);
    expect(events[1]).toMatchObject({ outcome: 'ran', reason: 'vad_shift' });
    expect(events[1].inputs.turnsSinceLast).toBe(2);
  });

  it('triggers appraisal immediately on significant VAD shift', async () => {
    const { provider } = makeMockProvider(['Shift appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
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

  it('fails closed after restart by seeding a reference snapshot without an appraisal', async () => {
    const { provider, complete } = makeMockProvider(['Unexpected restart appraisal']);
    const restarted = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
    });

    const result = await restarted.maybeAppraise({
      sessionId: 'session-restart',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.9, arousal: 0.8, dominance: 0.7 },
      }),
      recentMessages: [{ role: 'user', content: 'first turn after restart' }],
    });

    expect(result.appraised).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('persists one qualifying drift decision and deduplicates it across worker restart', async () => {
    const schedulerProvider = makeMockProvider(['Unexpected scheduler call']);
    const scheduler = new EmotionAppraisal({
      llmProvider: schedulerProvider.provider,
      vadDeltaThreshold: 0.2,
    });
    const baseline = projectEmotionAppraisalState(makeInternalState());
    baseline.emotional.vad = { valence: 0, arousal: 0, dominance: 0 };
    const target = structuredClone(baseline);
    target.emotional.vad = { valence: 0.5, arousal: 0.1, dominance: 0 };

    expect(scheduler.reserveNarrativeAppraisal({
      sessionId: 'session-durable-drift',
      appraisalState: baseline,
      now: TEST_NOW_MS,
    })).toBeNull();
    const decision = scheduler.reserveNarrativeAppraisal({
      sessionId: 'session-durable-drift',
      appraisalState: target,
      now: TEST_NOW_MS + 1,
    });
    expect(decision).toMatchObject({
      mode: 'drift_only',
      baselineVad: baseline.emotional.vad,
      targetVad: target.emotional.vad,
      vadDelta: 0.5,
      threshold: 0.2,
    });
    expect(scheduler.reserveNarrativeAppraisal({
      sessionId: 'session-durable-drift',
      appraisalState: target,
      now: TEST_NOW_MS + 2,
    })).toBeNull();
    expect(schedulerProvider.complete).not.toHaveBeenCalled();

    const workerProvider = makeMockProvider(['Durable drift appraisal']);
    const restartedWorker = new EmotionAppraisal({
      llmProvider: workerProvider.provider,
      vadDeltaThreshold: 0.2,
    });
    const run = () => restartedWorker.maybeAppraise({
      sessionId: 'session-durable-drift',
      appraisalState: target,
      driftDecision: decision!,
      recentMessages: [{ role: 'user' as const, content: 'bounded source turn' }],
      now: TEST_NOW_MS + 3,
    });

    await expect(run()).resolves.toMatchObject({ appraised: true, trigger: 'vad_shift' });
    await expect(run()).resolves.toMatchObject({ appraised: false });
    expect(workerProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('releases only the matching terminally failed narrative reservation', () => {
    const { provider, complete } = makeMockProvider(['Unexpected appraisal']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
    });
    const baseline = projectEmotionAppraisalState(makeInternalState());
    baseline.emotional.vad = { valence: 0, arousal: 0, dominance: 0 };
    const target = structuredClone(baseline);
    target.emotional.vad = { valence: 0.5, arousal: 0.1, dominance: 0 };
    expect(appraisal.reserveNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      appraisalState: baseline,
      now: TEST_NOW_MS,
    })).toBeNull();
    const decision = appraisal.reserveNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      appraisalState: target,
      now: TEST_NOW_MS + 1,
    })!;

    expect(appraisal.releaseNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      driftDecision: {
        ...decision,
        targetVad: { ...decision.targetVad, valence: 0.6 },
        vadDelta: 0.6,
      },
    })).toBe(false);
    expect(appraisal.releaseNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      driftDecision: decision,
    })).toBe(true);
    expect(appraisal.releaseNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      driftDecision: decision,
    })).toBe(false);
    expect(appraisal.reserveNarrativeAppraisal({
      sessionId: 'session-terminal-failure',
      appraisalState: target,
      now: TEST_NOW_MS + 2,
    })).toEqual(decision);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects unknown keys nested inside durable narrative VAD snapshots', () => {
    expect(() => parseNarrativeAppraisalDriftDecision({
      schemaVersion: 1,
      mode: 'drift_only',
      baselineVad: { valence: 0, arousal: 0, dominance: 0, privateContent: 'reject me' },
      targetVad: { valence: 0.5, arousal: 0, dominance: 0 },
      vadDelta: 0.5,
      threshold: 0.2,
    })).toThrow('baselineVad contains unknown keys: privateContent');
  });

  it('spends no narrative model calls when the owner-file mode is disabled', async () => {
    const { provider, complete } = makeMockProvider(['Unexpected disabled appraisal']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      mode: 'disabled',
      vadDeltaThreshold: 0.2,
    });

    await appraisal.maybeAppraise({
      sessionId: 'session-disabled',
      currentEmotion: makeSnapshot(),
      recentMessages: [],
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-disabled',
      currentEmotion: makeSnapshot({
        vad: { valence: 0.8, arousal: 0.8, dominance: 0.8 },
      }),
      recentMessages: [],
    });

    expect(complete).not.toHaveBeenCalled();
  });

  it('bounds prompt history input and trims chain length', async () => {
    const { provider, complete } = makeMockProvider([
      'first summary',
      'second summary',
      'third summary',
    ]);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
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
      currentEmotion: makeSnapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
      recentMessages,
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-bounded',
      currentEmotion: makeSnapshot(),
      recentMessages,
    });
    await appraisal.maybeAppraise({
      sessionId: 'session-bounded',
      currentEmotion: makeSnapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
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
      vadDeltaThreshold: 0.2,
    });

    await appraisal.maybeAppraise({
      sessionId: 'session-empty',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'baseline' }],
    });
    await expect(appraisal.maybeAppraise({
      sessionId: 'session-empty',
      currentEmotion: makeSnapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
      recentMessages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow('non-empty');
  });

  it('accepts InternalState input as the primary appraisal signal', async () => {
    const { provider, complete } = makeMockProvider(['Internal-state appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.1,
    });

    await appraisal.maybeAppraise({
      sessionId: 'session-internal-state',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'baseline' }],
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

  it('carries a companion-scoped static-prefix cache plan when companionId is set (d8vq.5)', async () => {
    // A pre-normalized custom system prompt so the appraisal's whitespace
    // collapse is a no-op and the boundaries are byte-predictable.
    const systemPrompt = 'You write a private first-person emotion appraisal.';
    const { provider, complete } = makeMockProvider(['Cache-plan appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
      companionId: '  companion-companion  ',
      systemPrompt,
    });

    await appraisal.maybeAppraise({
      sessionId: 'session-cache',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'baseline' }],
    });
    const result = await appraisal.maybeAppraise({
      sessionId: 'session-cache',
      currentEmotion: makeSnapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
      recentMessages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.appraised).toBe(true);

    const context = complete.mock.calls[0]?.[0] as {
      systemPrompt: string;
      promptCacheBoundaries?: unknown;
    };
    // The whole (static) system prompt is the cacheable prefix: both boundaries
    // are the full length, and the plan verifies against the sent prompt.
    const expected = buildSystemPromptCacheBoundaries({
      staticPrefixText: systemPrompt,
      sessionStablePrefixText: systemPrompt,
    });
    expect(context.systemPrompt).toBe(systemPrompt);
    expect(context.promptCacheBoundaries).toEqual(expected);
    expect(expected.staticPrefixChars).toBe(systemPrompt.length);
    expect(expected.sessionStablePrefixChars).toBe(systemPrompt.length);
    expect(
      verifySystemPromptCacheBoundaries(context.systemPrompt, expected),
    ).toBe(true);

    // Companion identity is folded into the correlation (outer cache scope),
    // trimmed to the normalized value.
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      correlation: { companionId: 'companion-companion' },
    });
  });

  it('offers no cache plan and no companion scope when companionId is absent (d8vq.5 fail-closed)', async () => {
    const { provider, complete } = makeMockProvider(['No-plan appraisal summary']);
    const appraisal = new EmotionAppraisal({
      llmProvider: provider,
      vadDeltaThreshold: 0.2,
    });

    await appraisal.maybeAppraise({
      sessionId: 'session-no-companion',
      currentEmotion: makeSnapshot(),
      recentMessages: [{ role: 'user', content: 'baseline' }],
    });
    const result = await appraisal.maybeAppraise({
      sessionId: 'session-no-companion',
      currentEmotion: makeSnapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
      recentMessages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.appraised).toBe(true);

    const context = complete.mock.calls[0]?.[0] as { promptCacheBoundaries?: unknown };
    expect(context.promptCacheBoundaries).toBeUndefined();
    const options = complete.mock.calls[0]?.[2] as {
      correlation?: { companionId?: unknown };
    };
    expect(options.correlation?.companionId).toBeUndefined();
  });
});
