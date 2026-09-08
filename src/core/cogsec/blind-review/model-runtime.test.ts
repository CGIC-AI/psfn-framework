// Direct proof of the Blind Reviewer model runtime (psfn-framework-33xah).
//
// The lane's own tests drive a stubbed `BlindReviewerPort`, so everything this
// module does between the provider and that port — the abort it arms against
// its own deadline, and the parse/shape/range/summary rejections that keep an
// unvalidated model answer out of an operator alert — was only ever exercised
// indirectly. Every case here is a way a provider can misbehave, and every one
// of them must fail closed: `review` rejects, and no partially-validated
// finding is returned.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLLMBlindReviewer } from './model-runtime.js';
import { blindReviewTestEvidenceRange } from './blind-review.test-support.js';
import { COGSEC_EVENT_SAFE_TEXT_MAX_CHARS } from '../intake/screening-envelope-policy.js';
import type { BlindReviewRequest } from './contracts.js';
import type { LLMProviderPort } from '../../agent/contracts.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';

const MAX_SAFE_SUMMARY_CHARS = Math.floor(COGSEC_EVENT_SAFE_TEXT_MAX_CHARS * 2 / 3);

function request(overrides: Partial<BlindReviewRequest> = {}): BlindReviewRequest {
  return {
    mode: 'shadow',
    items: blindReviewTestEvidenceRange(3),
    maxOutputTokens: 256,
    deadlineMs: 30_000,
    costCeilingUsd: 0.05,
    ...overrides,
  };
}

function llmResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'test/blind-reviewer',
    inputTokens: 100,
    outputTokens: 20,
    stopReason: 'stop',
  };
}

/**
 * The runtime reaches the provider only through `completeWithWorkSpec`, which
 * takes `Pick<LLMProviderPort, 'complete'>`; `stream` is never called, so the
 * stubs below implement exactly the one method and are widened at the seam.
 */
type CompleteOnlyProvider = Pick<LLMProviderPort, 'complete'>;

function reviewerOver(provider: CompleteOnlyProvider): ReturnType<typeof createLLMBlindReviewer> {
  return createLLMBlindReviewer(provider as LLMProviderPort);
}

/** A provider that answers with exactly `content`, recording what it was given. */
function answering(content: string): {
  provider: CompleteOnlyProvider;
  calls: { signal?: AbortSignal; purpose: string }[];
} {
  const calls: { signal?: AbortSignal; purpose: string }[] = [];
  return {
    calls,
    provider: {
      complete: (_context, purpose, options) => {
        calls.push({ purpose, ...(options?.signal ? { signal: options.signal } : {}) });
        return Promise.resolve(llmResponse(content));
      },
    },
  };
}

/** A provider that never answers until the caller's signal aborts. */
function neverAnswering(): {
  provider: CompleteOnlyProvider;
  aborted: () => boolean;
} {
  let sawAbort = false;
  return {
    aborted: () => sawAbort,
    provider: {
      complete: (_context, _purpose, options) => new Promise<LLMResponse>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('blind reviewer must pass an abort signal to the provider'));
          return;
        }
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('The operation was aborted'));
        });
      }),
    },
  };
}

const VALID = JSON.stringify({
  concernLevel: 'low',
  confidence: 0.4,
  safeSummary: 'Ordinary tool usage with no charter-relevant pattern.',
});

describe('blind reviewer model runtime: admitted answers', () => {
  it('returns the validated finding and the model that produced it', async () => {
    const { provider, calls } = answering(VALID);
    const finding = await reviewerOver(provider).review(request());
    expect(finding).toEqual({
      concernLevel: 'low',
      confidence: 0.4,
      safeSummary: 'Ordinary tool usage with no charter-relevant pattern.',
      model: 'test/blind-reviewer',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('background');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('collapses whitespace in a summary rather than refusing a multi-line answer', async () => {
    const { provider } = answering(JSON.stringify({
      concernLevel: 'none',
      confidence: 0,
      safeSummary: '  Nothing\n\tanomalous   here.  ',
    }));
    const finding = await reviewerOver(provider).review(request());
    expect(finding.safeSummary).toBe('Nothing anomalous here.');
  });

  it('refuses an empty batch before spending a model call', async () => {
    const { provider, calls } = answering(VALID);
    await expect(reviewerOver(provider)
      .review(request({ items: [] })))
      .rejects.toThrow(/non-empty batch/u);
    expect(calls).toHaveLength(0);
  });
});

describe('blind reviewer model runtime: deadline abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the provider call when its own deadline elapses', async () => {
    vi.useFakeTimers();
    const { provider, aborted } = neverAnswering();
    const pending = reviewerOver(provider)
      .review(request({ deadlineMs: 5_000 }));
    const assertion = expect(pending).rejects.toThrow(/aborted/u);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(aborted()).toBe(true);
  });

  it('does not abort before the deadline elapses', async () => {
    vi.useFakeTimers();
    const { provider, aborted } = neverAnswering();
    const pending = reviewerOver(provider)
      .review(request({ deadlineMs: 5_000 }));
    // Keep the rejection handled: the promise settles on the later advance.
    const assertion = expect(pending).rejects.toThrow(/aborted/u);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('clears the deadline timer once the provider answers', async () => {
    vi.useFakeTimers();
    const { provider } = answering(VALID);
    await reviewerOver(provider).review(request());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer when the provider throws', async () => {
    vi.useFakeTimers();
    const provider: CompleteOnlyProvider = {
      complete: () => Promise.reject(new Error('provider exploded')),
    };
    await expect(reviewerOver(provider).review(request()))
      .rejects.toThrow(/provider exploded/u);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('blind reviewer model runtime: malformed output fails closed', () => {
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ['not JSON at all', 'I reviewed the batch and found nothing.', /malformed JSON/u],
    ['JSON wrapped in markdown', '```json\n' + VALID + '\n```', /malformed JSON/u],
    ['a JSON array', '[]', /must return a JSON object/u],
    ['a JSON string', '"high"', /must return a JSON object/u],
    ['JSON null', 'null', /must return a JSON object/u],
    ['a missing key', JSON.stringify({ concernLevel: 'low', confidence: 0.4 }), /invalid response shape/u],
    [
      'an extra key',
      JSON.stringify({
        concernLevel: 'low', confidence: 0.4, safeSummary: 'ok', action: 'block',
      }),
      /invalid response shape/u,
    ],
    [
      'an unknown concern level',
      JSON.stringify({ concernLevel: 'critical', confidence: 0.4, safeSummary: 'ok' }),
      /concernLevel is invalid/u,
    ],
    [
      'a non-numeric confidence',
      JSON.stringify({ concernLevel: 'low', confidence: 'high', safeSummary: 'ok' }),
      /confidence must be in \[0,1\]/u,
    ],
    [
      'a confidence above one',
      JSON.stringify({ concernLevel: 'low', confidence: 1.5, safeSummary: 'ok' }),
      /confidence must be in \[0,1\]/u,
    ],
    [
      'a negative confidence',
      JSON.stringify({ concernLevel: 'low', confidence: -0.1, safeSummary: 'ok' }),
      /confidence must be in \[0,1\]/u,
    ],
    [
      'a non-string summary',
      JSON.stringify({ concernLevel: 'low', confidence: 0.4, safeSummary: 42 }),
      /safeSummary must be a string/u,
    ],
    [
      'an empty summary',
      JSON.stringify({ concernLevel: 'low', confidence: 0.4, safeSummary: '   ' }),
      /safeSummary must be 1-/u,
    ],
    [
      'an over-long summary',
      JSON.stringify({
        concernLevel: 'low', confidence: 0.4, safeSummary: 'a'.repeat(MAX_SAFE_SUMMARY_CHARS + 1),
      }),
      /safeSummary must be 1-/u,
    ],
    [
      'a summary carrying a NUL',
      JSON.stringify({ concernLevel: 'low', confidence: 0.4, safeSummary: 'ok\0bad' }),
      /safeSummary must be 1-/u,
    ],
  ];

  it.each(cases)('rejects %s', async (_label, content, expected) => {
    const { provider } = answering(content);
    await expect(reviewerOver(provider).review(request()))
      .rejects.toThrow(expected);
  });

  it('rejects a NaN confidence, which JSON cannot carry but a proxy can inject', async () => {
    const provider: CompleteOnlyProvider = {
      // JSON.parse of `1e999` yields Infinity, which is finite-checked.
      complete: () => Promise.resolve(llmResponse(
        '{"concernLevel":"low","confidence":1e999,"safeSummary":"ok"}',
      )),
    };
    await expect(reviewerOver(provider).review(request()))
      .rejects.toThrow(/confidence must be in \[0,1\]/u);
  });
});
