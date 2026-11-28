import { describe, expect, it, vi } from 'vitest';
import type { DecisionSiteSettings } from '../../../system/config/decision-backend-config.js';
import type { DecisionOutcome, DecisionRequest } from '../../../primitives/llm/decision/types.js';
import type { PurrMemory } from '../types.js';
import {
  applyDecisionRelevanceRerank,
  resolveQueryIntentRetrievalMode,
  type RetrievalDecisionPort,
} from './decision-routing.js';
import type { ScoredMemory } from './types.js';
import { logger } from '../../../shared/logger.js';

function scored(id: string, score: number, type: PurrMemory['type'] = 'fact'): ScoredMemory {
  return {
    memory: {
      id,
      text: `memory ${id}`,
      type,
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.8,
      sourceRef: `test:${id}`,
      extractedAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
      similarity: 0.8,
    },
    baseScore: score,
    evidenceSupport: 1,
    contradictionPenaltyMultiplier: 1,
    explicitlyQueried: false,
    lowConfidenceSingleSourceSuppressed: false,
    quietPreferenceSuppressed: false,
    preferenceContextBoost: 1,
    evidenceSourceCount: 1,
    privacyRisk: 0,
    privacyPenalty: 0,
    privacyBreakdown: { sensitivity: 0, tagBoost: 0, sourceContextAdjustment: 0, consentBoost: 0 },
    retrievalModeExcluded: false,
    score,
  };
}

function port(
  sites: Partial<Record<'memory.rerank' | 'memory.query_intent', DecisionSiteSettings>>,
  decide: (request: DecisionRequest) => Promise<DecisionOutcome>,
): RetrievalDecisionPort & { decide: ReturnType<typeof vi.fn> } {
  return {
    decide: vi.fn(decide),
    siteSettings: (siteId) => sites[siteId as 'memory.rerank'],
  };
}

function nouls(values: Record<string, number>): DecisionOutcome {
  return {
    ok: true,
    answers: Object.fromEntries(Object.entries(values).map(([name, pYes]) => [name, { type: 'noul', pYes }])),
    backend: 'jev',
    probabilitySource: 'jev',
    latencyMs: 30,
  };
}

const RERANK: DecisionSiteSettings = { enabled: true, topN: 3, latencyBudgetMs: 50, blendWeight: 0.5 };
const CANDIDATES = [scored('a', 1.0), scored('b', 0.9), scored('c', 0.8), scored('d', 0.1)];
const CONTEXT = { contextText: 'what did we plan for the trip?', channelId: 'dm-1', accessScope: 'channel_participant' as const };

describe('applyDecisionRelevanceRerank', () => {
  it('makes no decision call when the site is not enabled and reports it off', async () => {
    const decisions = port({}, async () => nouls({}));
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES }))
      .resolves.toEqual({ ranked: null, trace: { outcome: 'off' } });
    const disabled = port({ 'memory.rerank': { ...RERANK, enabled: false } }, async () => nouls({}));
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions: disabled, candidates: CANDIDATES }))
      .resolves.toEqual({ ranked: null, trace: { outcome: 'off' } });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(disabled.decide).not.toHaveBeenCalled();
  });

  it('reports a skipped decision when there is nothing to rerank', async () => {
    const decisions = port({ 'memory.rerank': RERANK }, async () => nouls({}));
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES.slice(0, 1) }))
      .resolves.toEqual({ ranked: null, trace: { outcome: 'skipped' } });
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('scores the top-N in one batched decision and reorders by the blended score', async () => {
    const decisions = port({ 'memory.rerank': RERANK }, async () => nouls({ m0: 0.1, m1: 0.5, m2: 0.95 }));
    const { ranked, trace } = await applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES });
    expect(ranked?.map((item) => item.memory.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(ranked?.find((item) => item.memory.id === 'b')?.score).toBeCloseTo(0.9);
    expect(ranked?.find((item) => item.memory.id === 'd')?.score).toBe(0.1);
    expect(trace).toEqual({ outcome: 'applied', backend: 'jev', latencyMs: expect.any(Number), changed: true });

    expect(decisions.decide).toHaveBeenCalledTimes(1);
    const request = decisions.decide.mock.calls[0]?.[0] as DecisionRequest;
    expect(request.siteId).toBe('memory.rerank');
    expect(Object.keys(request.questions)).toEqual(['m0', 'm1', 'm2']);
    expect(request.state).toEqual({
      turn: 'what did we plan for the trip?',
      memories: {
        m0: { type: 'fact', text: 'memory a' },
        m1: { type: 'fact', text: 'memory b' },
        m2: { type: 'fact', text: 'memory c' },
      },
    });
  });

  it('reports an applied rerank that kept the order as unchanged', async () => {
    const decisions = port({ 'memory.rerank': RERANK }, async () => nouls({ m0: 0.9, m1: 0.5, m2: 0.1 }));
    const { ranked, trace } = await applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES });
    expect(ranked?.map((item) => item.memory.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(trace).toMatchObject({ outcome: 'applied', changed: false });
  });

  it('falls back to lexical order on a failed decision and reports the failure', async () => {
    const decisions = port({ 'memory.rerank': RERANK }, async () => ({
      ok: false, reason: 'error', backend: 'local-fallback', latencyMs: 4,
    }));
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES })).resolves.toEqual({
      ranked: null,
      trace: { outcome: 'error', backend: 'local-fallback', failureReason: 'error', latencyMs: expect.any(Number) },
    });
  });

  it('reports a thrown decision as an error instead of swallowing it', async () => {
    const written = vi.spyOn(logger, 'write');
    const decisions = port({ 'memory.rerank': RERANK }, async () => {
      throw new Error('private failure detail');
    });
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES })).resolves.toEqual({
      ranked: null,
      trace: { outcome: 'error', failureReason: 'thrown', latencyMs: expect.any(Number) },
    });
    const warning = written.mock.calls.map(([info]) => info as Record<string, unknown>)
      .find(info => info.message === 'Retrieval decision failed; keeping the lexical result');
    written.mockRestore();
    expect(warning).toMatchObject({ level: 'warn', siteId: 'memory.rerank', channelId: 'dm-1', errorName: 'Error' });
    expect(JSON.stringify(warning)).not.toContain('private failure detail');
    expect(JSON.stringify(warning)).not.toContain('memory a');
  });

  it('enforces the latency budget, falls back, and reports the timeout', async () => {
    const decisions = port({ 'memory.rerank': { ...RERANK, latencyBudgetMs: 20 } }, () => new Promise(() => {}));
    const startedAt = Date.now();
    await expect(applyDecisionRelevanceRerank({ ...CONTEXT, decisions, candidates: CANDIDATES })).resolves.toEqual({
      ranked: null,
      trace: { outcome: 'timeout', latencyMs: expect.any(Number) },
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    const request = decisions.decide.mock.calls[0]?.[0] as DecisionRequest;
    expect(request.signal?.aborted).toBe(true);
  });

  it('keeps companion self-reflection retrieval companion-private', async () => {
    const decisions = port({ 'memory.rerank': RERANK }, async () => nouls({ m0: 0.5, m1: 0.5, m2: 0.5 }));
    await applyDecisionRelevanceRerank({
      ...CONTEXT, accessScope: 'companion_self_reflection', decisions, candidates: CANDIDATES,
    });
    const request = decisions.decide.mock.calls[0]?.[0] as DecisionRequest;
    expect(request.workSpec.correlation?.telemetryVisibility).toBe('companion_private');
  });
});

describe('resolveQueryIntentRetrievalMode', () => {
  const INTENT: DecisionSiteSettings = { enabled: true, threshold: 0.7, latencyBudgetMs: 50 };

  it('routes a time-scoped turn to temporal mode above the threshold', async () => {
    const decisions = port({ 'memory.query_intent': INTENT }, async () => nouls({ time_scoped: 0.9 }));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions, current: undefined })).resolves.toEqual({
      mode: 'temporal',
      trace: { outcome: 'applied', backend: 'jev', latencyMs: expect.any(Number), changed: true },
    });
  });

  it('leaves the mode unchanged below the threshold, on failure, or on timeout, and says which', async () => {
    const low = port({ 'memory.query_intent': INTENT }, async () => nouls({ time_scoped: 0.4 }));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions: low, current: undefined }))
      .resolves.toMatchObject({ mode: undefined, trace: { outcome: 'applied', changed: false } });
    const failing = port({ 'memory.query_intent': INTENT }, async () => {
      throw new Error('boom');
    });
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions: failing, current: undefined }))
      .resolves.toMatchObject({ mode: undefined, trace: { outcome: 'error', failureReason: 'thrown' } });
    const hanging = port({ 'memory.query_intent': { ...INTENT, latencyBudgetMs: 20 } }, () => new Promise(() => {}));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions: hanging, current: undefined }))
      .resolves.toMatchObject({ mode: undefined, trace: { outcome: 'timeout' } });
    const unusable = port({ 'memory.query_intent': INTENT }, async () => nouls({}));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions: unusable, current: undefined }))
      .resolves.toMatchObject({ mode: undefined, trace: { outcome: 'error', failureReason: 'unusable_answer' } });
  });

  it('never overrides an explicit or deterministic mode, and is silent when disabled', async () => {
    const decisions = port({ 'memory.query_intent': INTENT }, async () => nouls({ time_scoped: 1 }));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions, current: 'reflection' }))
      .resolves.toEqual({ mode: 'reflection', trace: { outcome: 'skipped' } });
    const off = port({}, async () => nouls({ time_scoped: 1 }));
    await expect(resolveQueryIntentRetrievalMode({ ...CONTEXT, decisions: off, current: undefined }))
      .resolves.toEqual({ mode: undefined, trace: { outcome: 'off' } });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(off.decide).not.toHaveBeenCalled();
  });
});
