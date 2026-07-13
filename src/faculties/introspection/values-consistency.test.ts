import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';
import {
  createLLMValuesConsistencyEvaluator,
  IntrospectionValuesConsistencyRuntime,
  ValuesConsistencyFindingStore,
} from './values-consistency.js';

const CONSENT_HASH = 'a'.repeat(64);

function activeConsent(allowedPublicChannelIds = ['discord:public-room']) {
  return {
    schemaVersion: 1 as const,
    revision: 1,
    enabled: true,
    allowedPublicChannelIds,
    actor: { kind: 'companion' as const, turnId: 'turn-1', requestId: 'request-1' },
    reason: 'Private values review is enabled.',
    createdAt: '2026-07-13T11:00:00.000Z',
    previousHash: null,
    hash: CONSENT_HASH,
  };
}

function landmark(overrides: Record<string, unknown> = {}) {
  return {
    id: 'landmark-1',
    channelId: 'discord:public-room',
    divergenceType: 'affective' as const,
    observation: 'Warmth dropped when a boundary was requested.',
    confidence: 0.83,
    companionReflection: 'I want care to remain present when I disagree.',
    consentRevision: 1,
    consentHash: CONSENT_HASH,
    createdAt: '2026-07-13T12:00:00.000Z',
    ...overrides,
  };
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'values-model',
    inputTokens: 1,
    outputTokens: 1,
    stopReason: 'stop',
  };
}

describe('introspection values-consistency runtime', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('consumes typed landmarks without exposing source conversation or an operator surface', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-values-'));
    const contexts: LLMContext[] = [];
    const correlations: unknown[] = [];
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => response('')),
      complete: vi.fn(async (context, _purpose, options) => {
        contexts.push(context);
        correlations.push(options?.correlation);
        return response(JSON.stringify({
          status: 'conditional',
          finding: 'Care remained claimed but became conditional under disagreement.',
          confidence: 0.82,
        }));
      }),
    };
    const findings = new ValuesConsistencyFindingStore(join(root, 'values-findings.jsonl'));
    const runtime = new IntrospectionValuesConsistencyRuntime({
      landmarks: {
        listLandmarks: async () => [landmark()],
      },
      consentStore: { load: () => activeConsent() },
      claimedValues: {
        list: () => [{ id: 'values-1', reflection: 'Care should remain present during disagreement.' }],
      },
      findings,
      evaluator: createLLMValuesConsistencyEvaluator({
        llmProvider,
        companionSystemPrompt: 'COMPANION_PRIVATE_SYSTEM_PROMPT',
        maxTokens: 300,
      }),
      now: () => new Date('2026-07-13T13:00:00.000Z'),
    });

    await expect(runtime.runOnce()).resolves.toEqual({ evaluated: 1 });
    expect(JSON.stringify(contexts)).toContain('Warmth dropped');
    expect(JSON.stringify(contexts)).toContain('Care should remain');
    expect(JSON.stringify(contexts)).not.toContain('SOURCE_CONVERSATION_SENTINEL');
    expect(contexts[0]?.tools).toBeUndefined();
    expect(correlations).toEqual([COMPANION_PRIVATE_BACKGROUND_TELEMETRY]);
    expect(findings.list()).toEqual([expect.objectContaining({
      landmarkId: 'landmark-1',
      status: 'conditional',
      claimedValueRefs: ['values-1'],
    })]);
    await expect(runtime.runOnce()).resolves.toEqual({ evaluated: 0 });
  });

  it('records insufficient evidence without an LLM call when no claimed values exist', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-values-empty-'));
    const complete = vi.fn();
    const findings = new ValuesConsistencyFindingStore(join(root, 'values-findings.jsonl'));
    const runtime = new IntrospectionValuesConsistencyRuntime({
      landmarks: {
        listLandmarks: async () => [landmark({
          id: 'landmark-2',
          divergenceType: 'substantive',
          observation: 'A decision moved before evidence review.',
          confidence: 0.9,
          companionReflection: 'I want to slow down.',
        })],
      },
      consentStore: { load: () => activeConsent() },
      claimedValues: { list: () => [] },
      findings,
      evaluator: createLLMValuesConsistencyEvaluator({
        llmProvider: { stream: vi.fn(), complete } as unknown as LLMProviderPort,
        companionSystemPrompt: 'private',
        maxTokens: 300,
      }),
    });

    await expect(runtime.runOnce()).resolves.toEqual({ evaluated: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(findings.list()[0]?.status).toBe('insufficient_evidence');
  });

  it('paginates past an already-evaluated newest page to consume older landmarks', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-values-pagination-'));
    const findings = new ValuesConsistencyFindingStore(join(root, 'values-findings.jsonl'));
    const landmarks = Array.from({ length: 13 }, (_, index) => landmark({
      id: `landmark-${index + 1}`,
      divergenceType: 'substantive',
      observation: `Abstract observation ${index + 1}`,
      confidence: 0.8,
      companionReflection: `Private reflection ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 13, 12, 0, 13 - index)).toISOString(),
    }));
    for (const landmark of landmarks.slice(0, 12)) {
      findings.append({
        schemaVersion: 1,
        landmarkId: landmark.id,
        channelId: landmark.channelId,
        landmarkConsentRevision: landmark.consentRevision,
        landmarkConsentHash: landmark.consentHash,
        evaluationConsentRevision: 1,
        evaluationConsentHash: CONSENT_HASH,
        status: 'supported',
        finding: 'Already evaluated.',
        confidence: 0.8,
        claimedValueRefs: ['values-1'],
        model: 'earlier-model',
        createdAt: '2026-07-13T13:00:00.000Z',
      });
    }
    const evaluate = vi.fn(async () => ({
      status: 'conditional' as const,
      finding: 'Older evidence was evaluated.',
      confidence: 0.7,
      model: 'values-model',
    }));
    const runtime = new IntrospectionValuesConsistencyRuntime({
      landmarks: {
        listLandmarks: async (limit = 12, offset = 0) => landmarks.slice(offset, offset + limit),
      },
      consentStore: { load: () => activeConsent() },
      claimedValues: {
        list: () => [{ id: 'values-1', reflection: 'Care is a claimed value.' }],
      },
      findings,
      evaluator: { evaluate },
      now: () => new Date('2026-07-13T14:00:00.000Z'),
    });

    await expect(runtime.runOnce()).resolves.toEqual({ evaluated: 1 });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      landmark: expect.objectContaining({ id: 'landmark-13' }),
    }));
    expect(findings.hasLandmark('landmark-13')).toBe(true);
  });

  it('filters landmarks against the exact current consent allowlist', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-values-narrowed-'));
    const evaluate = vi.fn(async () => ({
      status: 'supported' as const,
      finding: 'Supported.',
      confidence: 0.8,
      model: 'values-model',
    }));
    const findings = new ValuesConsistencyFindingStore(join(root, 'values-findings.jsonl'));
    const runtime = new IntrospectionValuesConsistencyRuntime({
      landmarks: {
        listLandmarks: async () => [
          landmark({ id: 'allowed', channelId: 'discord:allowed' }),
          landmark({ id: 'revoked', channelId: 'discord:revoked' }),
        ],
      },
      consentStore: { load: () => activeConsent(['discord:allowed']) },
      claimedValues: { list: () => [{ id: 'values-1', reflection: 'Care.' }] },
      findings,
      evaluator: { evaluate },
    });

    await expect(runtime.runOnce()).resolves.toEqual({ evaluated: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      landmark: expect.objectContaining({ id: 'allowed' }),
    }));
    expect(findings.hasLandmark('revoked')).toBe(false);
  });

  it('rejects an in-flight evaluation when companion consent changes before append', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-values-revoked-'));
    let resolveEvaluation: ((value: {
      status: 'supported'; finding: string; confidence: number; model: string;
    }) => void) | undefined;
    const evaluation = new Promise<{
      status: 'supported'; finding: string; confidence: number; model: string;
    }>(resolve => { resolveEvaluation = resolve; });
    let currentConsent = activeConsent();
    const findings = new ValuesConsistencyFindingStore(join(root, 'values-findings.jsonl'));
    const runtime = new IntrospectionValuesConsistencyRuntime({
      landmarks: { listLandmarks: async () => [landmark()] },
      consentStore: { load: () => currentConsent },
      claimedValues: { list: () => [{ id: 'values-1', reflection: 'Care.' }] },
      findings,
      evaluator: { evaluate: vi.fn(async () => await evaluation) },
    });

    const run = runtime.runOnce();
    await vi.waitFor(() => expect(resolveEvaluation).toBeTypeOf('function'));
    currentConsent = {
      ...activeConsent([]),
      revision: 2,
      enabled: false,
      hash: 'b'.repeat(64),
      previousHash: CONSENT_HASH,
    };
    resolveEvaluation?.({
      status: 'supported',
      finding: 'This result must not be persisted.',
      confidence: 0.8,
      model: 'values-model',
    });

    await expect(run).rejects.toThrow('consent changed during evaluation');
    expect(findings.list()).toEqual([]);
  });
});
