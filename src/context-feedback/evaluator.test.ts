import { describe, expect, it, vi } from 'vitest';
import type { ContextManifest } from '../core/session/context-manifest.js';
import { ContextEvaluator, parseContextEvaluationResponse } from './evaluator.js';

function makeManifest(): ContextManifest {
  return {
    channelId: 'terminal:test',
    generatedAt: 1_700_000_000_000,
    session: {
      sourceEntryCount: 12,
      trimmedEntryCount: 0,
      maskedEntryCount: 0,
      compactedEntryCount: 0,
      finalEntryCount: 12,
      finalMessageCount: 12,
      compactionSummaryCount: 0,
      continuityEntryCount: 0,
    },
    memory: {
      includedCount: 3,
      includedTypes: { semantic: 2, procedural: 1 },
      includedTokenCount: 420,
      reason: 'ranked',
      candidateCount: 8,
      policyAllowedCount: 6,
      rankedCount: 5,
      returnedCount: 3,
      excluded: {
        sensitivityRejectedCount: 0,
        policyRejectedCount: 1,
        scoreRejectedCount: 1,
        budgetCappedCount: 1,
      },
      retrieval: {
        mode: 'budget',
        budgetPct: 3,
        tokenBudget: 1_000,
        limit: 6,
      },
    },
    budgets: {
      contextWindow: 128_000,
      adaptive: {
        enabled: true,
        source: 'default',
        category: 'default',
      },
      sessionHistory: {
        mode: 'budget',
        budgetPct: 6,
        tokenBudget: 8_000,
        estimatedCount: 24,
        actualCount: 12,
        actualTokenCount: 1_900,
      },
      memoryRetrieval: {
        mode: 'budget',
        budgetPct: 3,
        tokenBudget: 1_000,
        estimatedCount: 6,
        actualCount: 3,
        actualTokenCount: 420,
      },
      sections: [
        { section: 'system_prompt', tokenCount: 1_200 },
        { section: 'session_history', tokenCount: 1_900 },
      ],
    },
    compaction: {
      triggered: false,
      thresholdPct: 70,
      tokenBudget: 90_000,
      totalTokensBefore: 4_000,
      totalTokensAfter: 4_000,
    },
  };
}

describe('parseContextEvaluationResponse', () => {
  it('parses strict evaluator JSON and preserves signal booleans', () => {
    const parsed = parseContextEvaluationResponse(
      [
        '```json',
        '{',
        '  "effectivenessScore": 0.82,',
        '  "signals": {',
        '    "confabulation": false,',
        '    "missed_context": false,',
        '    "wasted_tokens": false,',
        '    "good": true',
        '  },',
        '  "summary": "Context fit the request and avoided irrelevant history."',
        '}',
        '```',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      effectivenessScore: 0.82,
      signals: {
        confabulation: false,
        missed_context: false,
        wasted_tokens: false,
        good: true,
      },
      summary: 'Context fit the request and avoided irrelevant history.',
    });
  });

  it('fails closed when required signal keys are missing', () => {
    expect(() => parseContextEvaluationResponse(JSON.stringify({
      effectivenessScore: 0.4,
      signals: {
        confabulation: false,
        missed_context: true,
        good: false,
      },
      summary: 'Missing signal key should fail.',
    }))).toThrow(/signals\.wasted_tokens/);
  });
});

describe('ContextEvaluator', () => {
  it('calls the context-purpose model and returns normalized result', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        effectivenessScore: 0.67,
        signals: {
          confabulation: false,
          missed_context: true,
          wasted_tokens: false,
          good: false,
        },
        summary: 'Missed relevant prior memory mention.',
      }),
      model: 'context-evaluator-model',
      toolCalls: [],
      inputTokens: 180,
      outputTokens: 42,
      stopReason: 'stop',
    });
    const evaluator = new ContextEvaluator({
      stream: vi.fn(),
      complete,
    });

    const result = await evaluator.evaluate({
      turnId: 'turn-ctx-1',
      channelId: 'terminal:test',
      contextManifest: makeManifest(),
      userMessage: 'Can you remember my exam timeline?',
      assistantResponse: 'I do not recall anything yet.',
      responseMetadata: {
        model: 'chat-model',
        inputTokens: 550,
        outputTokens: 120,
      },
    });

    expect(complete).toHaveBeenCalledWith(expect.anything(), 'context');
    expect(result).toEqual({
      effectivenessScore: 0.67,
      signals: {
        confabulation: false,
        missed_context: true,
        wasted_tokens: false,
        good: false,
      },
      summary: 'Missed relevant prior memory mention.',
      evaluationModel: 'context-evaluator-model',
    });
  });
});
