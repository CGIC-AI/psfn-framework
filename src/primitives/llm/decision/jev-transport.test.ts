import { describe, expect, it, vi } from 'vitest';
import {
  buildJevDecisionsRequestBody,
  requestJevDecision,
  type DecisionsFetch,
} from './jev-transport.js';
import { TUTORIAL_REQUEST_BODY, TUTORIAL_RESPONSE_BODY } from './jev-transport.test-fixtures.js';
import type { DecisionQuestionSet } from './types.js';

const QUESTIONS = TUTORIAL_REQUEST_BODY.questions as unknown as DecisionQuestionSet;
const STATE = TUTORIAL_REQUEST_BODY.state;
const CONFIG = {
  endpointUrl: 'https://openrouter.ai/api/alpha/decisions',
  apiKey: 'sk-or-test-key',
  model: 'typesafe/jev-1.13',
  expectedSnapshot: null,
};

function fetchReturning(status: number, body: unknown): DecisionsFetch & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
}

function run(fetch: DecisionsFetch, config = CONFIG) {
  let tick = 0;
  return requestJevDecision(config, { state: STATE, questions: QUESTIONS }, {
    fetch,
    signal: new AbortController().signal,
    now: () => (tick += 60),
  });
}

describe('buildJevDecisionsRequestBody', () => {
  it('matches the documented request and pins zero-retention routing', () => {
    expect(buildJevDecisionsRequestBody('typesafe/jev-1.13', STATE, QUESTIONS)).toEqual({
      ...TUTORIAL_REQUEST_BODY,
      provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false },
    });
  });
});

describe('requestJevDecision (recorded tutorial fixture)', () => {
  it('posts the body with bearer auth and maps the recorded answers', async () => {
    const fetch = fetchReturning(200, TUTORIAL_RESPONSE_BODY);
    const result = await run(fetch);

    const [url, init] = fetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-or-test-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'typesafe/jev-1.13' });

    expect(result).toEqual({
      outcome: {
        ok: true,
        backend: 'jev',
        probabilitySource: 'jev',
        latencyMs: 60,
        model: 'typesafe/jev-1.13-20260917',
        costUsd: 0.000019992,
        answers: {
          is_bug: { type: 'noul', pYes: 0.96 },
          team: {
            type: 'choice',
            choice: 'payments',
            confidence: 0.67,
            probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
          },
          urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0, 2: 1 } },
        },
      },
      usage: { inputTokens: 476, outputTokens: 70 },
      httpStatus: 200,
    });
  });

  it('accepts the response when it names the expected dated snapshot', async () => {
    const result = await run(fetchReturning(200, TUTORIAL_RESPONSE_BODY), {
      ...CONFIG,
      expectedSnapshot: 'typesafe/jev-1.13-20260917',
    });
    expect(result.outcome.ok).toBe(true);
  });

  it('treats a different snapshot than the expected one as drift', async () => {
    const result = await run(fetchReturning(200, TUTORIAL_RESPONSE_BODY), {
      ...CONFIG,
      expectedSnapshot: 'typesafe/jev-1.13-20261001',
    });
    expect(result.outcome).toMatchObject({ ok: false, reason: 'invalid_output', backend: 'jev' });
  });

  it('treats a response from another model as drift', async () => {
    const result = await run(fetchReturning(200, { ...TUTORIAL_RESPONSE_BODY, model: 'typesafe/jev-2.0-20270101' }));
    expect(result.outcome).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it.each([
    ['non-JSON body', '<html>maintenance</html>'],
    ['missing answers', { ...TUTORIAL_RESPONSE_BODY, answers: undefined }],
    ['missing usage', { ...TUTORIAL_RESPONSE_BODY, usage: undefined }],
    ['a choice outside the criteria', {
      ...TUTORIAL_RESPONSE_BODY,
      answers: { ...TUTORIAL_RESPONSE_BODY.answers, team: { type: 'choice', choice: 'legal' } },
    }],
    ['a renamed noul field', {
      ...TUTORIAL_RESPONSE_BODY,
      answers: { ...TUTORIAL_RESPONSE_BODY.answers, is_bug: { type: 'noul', p_yes: 0.9 } },
    }],
    ['a dropped question', {
      ...TUTORIAL_RESPONSE_BODY,
      answers: { is_bug: TUTORIAL_RESPONSE_BODY.answers.is_bug, team: TUTORIAL_RESPONSE_BODY.answers.team },
    }],
  ])('fails closed on %s', async (_label, body) => {
    const result = await run(fetchReturning(200, body));
    expect(result.outcome).toMatchObject({ ok: false, reason: 'invalid_output', backend: 'jev' });
  });

  it.each([400, 401, 402, 413, 429, 500, 502, 503, 524, 529])('returns a typed error for HTTP %i', async (status) => {
    const result = await run(fetchReturning(status, { error: { code: status, message: 'nope' } }));
    expect(result).toMatchObject({ outcome: { ok: false, reason: 'error', backend: 'jev' }, httpStatus: status });
  });

  it('returns a typed error when the network call throws', async () => {
    const result = await run(vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(result.outcome).toMatchObject({ ok: false, reason: 'error' });
  });

  it('reports aborted when the signal fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await requestJevDecision(CONFIG, { state: STATE, questions: QUESTIONS }, {
      fetch: vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
      signal: controller.signal,
    });
    expect(result.outcome).toMatchObject({ ok: false, reason: 'aborted' });
  });
});
