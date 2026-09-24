import { describe, expect, it, vi } from 'vitest';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { buildLLMWorkSpec } from '../work-spec.js';
import type { DecisionLocalQuestionMode } from '../../../system/config/decision-backend-config.js';
import { createLocalDecisionBackend } from './local-backend.js';
import type { DecisionQuestionSet, DecisionRequest } from './types.js';

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'test-background-model',
    inputTokens: 10,
    outputTokens: 5,
    stopReason: 'stop',
  };
}

function scriptedProvider(outputs: Array<string | Error>): Pick<LLMProviderPort, 'complete'> & {
  complete: ReturnType<typeof vi.fn>;
} {
  const queue = [...outputs];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted output left');
      if (next instanceof Error) throw next;
      return makeResponse(next);
    }),
  };
}

const QUESTIONS: DecisionQuestionSet = {
  is_bug: {
    type: 'noul',
    instructions: 'Is the customer reporting a software defect?',
    criteria: { true: 'Broken behaviour.', false: 'A question or feature request.' },
  },
  team: {
    type: 'choice',
    instructions: 'Which team should own this ticket?',
    criteria: { payments: 'Checkout issues.', frontend: 'Rendering issues.' },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this ticket?',
    criteria: ['Can wait', 'This week', 'Blocking revenue'],
  },
};

const VALID_OUTPUT = JSON.stringify({
  answers: {
    is_bug: { type: 'noul', noul: 0.9 },
    team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.8, frontend: 0.2 }, confidence: 0.7 },
    urgency: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0.1, 2: 0.9 }, confidence: 0.9 },
  },
});

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    siteId: 'room.ambiguity',
    state: { ticket: 'Checkout shows a blank page.' },
    questions: QUESTIONS,
    workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false, maxOutputTokens: 256 }),
    ...overrides,
  };
}

function backendFor(
  provider: Pick<LLMProviderPort, 'complete'>,
  mode: DecisionLocalQuestionMode = 'combined',
  extra: Partial<Parameters<typeof createLocalDecisionBackend>[0]> = {},
) {
  let tick = 0;
  return createLocalDecisionBackend({
    llmProvider: provider,
    resolveQuestionMode: () => mode,
    now: () => (tick += 5),
    ...extra,
  });
}

describe('createLocalDecisionBackend', () => {
  it('answers noul, choice and score questions from one combined decision-purpose call', async () => {
    const provider = scriptedProvider([VALID_OUTPUT]);
    const outcome = await backendFor(provider).decide(makeRequest());

    expect(outcome).toEqual({
      ok: true,
      backend: 'local',
      probabilitySource: 'self_report_uncalibrated',
      latencyMs: 5,
      answers: {
        is_bug: { type: 'noul', pYes: 0.9 },
        team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.8, frontend: 0.2 }, confidence: 0.7 },
        urgency: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0.1, 2: 0.9 }, confidence: 0.9 },
      },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.complete.mock.calls[0]?.[1]).toBe('decision');
    const context = provider.complete.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    expect(context.messages[0]?.content).toContain('"0":"Can wait"');
  });

  it('tolerates code fences around the JSON object', async () => {
    const provider = scriptedProvider([`\`\`\`json\n${VALID_OUTPUT}\n\`\`\``]);
    const outcome = await backendFor(provider).decide(makeRequest());
    expect(outcome.ok).toBe(true);
  });

  it('retries invalid output once and then succeeds', async () => {
    const provider = scriptedProvider(['not json at all', VALID_OUTPUT]);
    const outcome = await backendFor(provider).decide(makeRequest());
    expect(outcome.ok).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('returns a typed invalid_output failure after the retry is spent', async () => {
    const unknownOption = JSON.stringify({
      answers: {
        is_bug: { type: 'noul', noul: 0.9 },
        team: { type: 'choice', choice: 'legal' },
        urgency: { type: 'score', score: 1 },
      },
    });
    const provider = scriptedProvider([unknownOption, unknownOption]);
    const outcome = await backendFor(provider).decide(makeRequest());
    expect(outcome).toEqual({ ok: false, reason: 'invalid_output', backend: 'local', latencyMs: 5 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing answer', { is_bug: { type: 'noul', noul: 0.5 }, team: { type: 'choice', choice: 'payments' } }],
    ['type mismatch', {
      is_bug: { type: 'choice', choice: 'payments' },
      team: { type: 'choice', choice: 'payments' },
      urgency: { type: 'score', score: 1 },
    }],
    ['noul out of range', {
      is_bug: { type: 'noul', noul: 1.4 },
      team: { type: 'choice', choice: 'payments' },
      urgency: { type: 'score', score: 1 },
    }],
    ['score beyond the last level', {
      is_bug: { type: 'noul', noul: 0.4 },
      team: { type: 'choice', choice: 'payments' },
      urgency: { type: 'score', score: 3 },
    }],
    ['extra answer', {
      is_bug: { type: 'noul', noul: 0.4 },
      team: { type: 'choice', choice: 'payments' },
      urgency: { type: 'score', score: 1 },
      bonus: { type: 'noul', noul: 1 },
    }],
  ])('rejects %s', async (_label, answers) => {
    const output = JSON.stringify({ answers });
    const provider = scriptedProvider([output, output]);
    const outcome = await backendFor(provider).decide(makeRequest());
    expect(outcome.ok).toBe(false);
  });

  it('returns a typed error failure without retrying provider errors', async () => {
    const provider = scriptedProvider([new Error('upstream echoed untrusted state')]);
    const outcome = await backendFor(provider).decide(makeRequest());
    expect(outcome).toEqual({ ok: false, reason: 'error', backend: 'local', latencyMs: 5 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('runs one call per question in per_question mode and merges the answers', async () => {
    const provider = scriptedProvider([
      JSON.stringify({ answers: { is_bug: { type: 'noul', noul: 0.2 } } }),
      JSON.stringify({ answers: { team: { type: 'choice', choice: 'frontend' } } }),
      JSON.stringify({ answers: { urgency: { type: 'score', score: 0 } } }),
    ]);
    const outcome = await backendFor(provider, 'per_question').decide(makeRequest());
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(outcome.ok && outcome.answers).toEqual({
      is_bug: { type: 'noul', pYes: 0.2 },
      team: { type: 'choice', choice: 'frontend' },
      urgency: { type: 'score', score: 0 },
    });
  });

  it('prefers token logprobs over self-reported probabilities for a single choice question', async () => {
    const provider = scriptedProvider([
      JSON.stringify({ answers: { team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.99 } } } }),
    ]);
    const readDistribution = vi.fn(async () => ({ payments: 0.35, frontend: 0.65 }));
    const outcome = await backendFor(provider, 'combined', { logprobs: { readDistribution } }).decide(makeRequest({
      questions: { team: QUESTIONS.team! },
    }));
    expect(outcome).toMatchObject({
      ok: true,
      probabilitySource: 'logprob',
      answers: { team: { type: 'choice', choice: 'frontend', probabilities: { payments: 0.35, frontend: 0.65 } } },
    });
  });

  it('keeps self-reported probabilities when the logprob reader has no distribution', async () => {
    const provider = scriptedProvider([JSON.stringify({ answers: { is_bug: { type: 'noul', noul: 0.7 } } })]);
    const outcome = await backendFor(provider, 'combined', {
      logprobs: { readDistribution: async () => null },
    }).decide(makeRequest({ questions: { is_bug: QUESTIONS.is_bug! } }));
    expect(outcome).toMatchObject({
      ok: true,
      probabilitySource: 'self_report_uncalibrated',
      answers: { is_bug: { type: 'noul', pYes: 0.7 } },
    });
  });

  it('refuses a work spec that does not declare the decision purpose', async () => {
    const provider = scriptedProvider([VALID_OUTPUT]);
    await expect(backendFor(provider).decide(makeRequest({
      workSpec: buildLLMWorkSpec({ purpose: 'background', durable: false }),
    }))).rejects.toThrow(/purpose "decision"/);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
