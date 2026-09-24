import { describe, expect, it, vi } from 'vitest';
import type { DecisionOutcome } from '../../../primitives/llm/decision/types.js';
import { createGatewayRemoteDecisionBackend } from './gateway-remote-backend.js';

const REQUEST = {
  siteId: 'room.ambiguity' as const,
  state: { message: 'anyone around?' },
  questions: {
    relevant: { type: 'noul' as const, instructions: 'Is this relevant?' },
    tone: { type: 'choice' as const, instructions: 'Tone?', criteria: { calm: 'Calm.', urgent: 'Urgent.' } },
  },
};

function backendReturning(result: DecisionOutcome) {
  const decide = vi.fn(async () => result);
  return { backend: createGatewayRemoteDecisionBackend({ decide }), decide };
}

describe('createGatewayRemoteDecisionBackend', () => {
  it('forwards only site, state and questions and keeps valid answers', async () => {
    const result: DecisionOutcome = {
      ok: true,
      answers: { relevant: { type: 'noul', pYes: 0.6 }, tone: { type: 'choice', choice: 'calm' } },
      backend: 'jev',
      probabilitySource: 'jev',
      latencyMs: 90,
      model: 'typesafe/jev-1.13-20260917',
    };
    const { backend, decide } = backendReturning(result);
    const signal = new AbortController().signal;
    await expect(backend.decide(REQUEST, signal)).resolves.toEqual(result);
    expect(decide).toHaveBeenCalledWith(REQUEST, signal);
  });

  it('turns answers that do not match the questions into invalid_output', async () => {
    const { backend } = backendReturning({
      ok: true,
      answers: { relevant: { type: 'noul', pYes: 0.6 }, tone: { type: 'choice', choice: 'furious' } },
      backend: 'jev',
      probabilitySource: 'jev',
      latencyMs: 90,
    });
    await expect(backend.decide(REQUEST, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'invalid_output', backend: 'jev', latencyMs: 90 });
  });

  it('passes a remote failure through as a jev failure', async () => {
    const { backend } = backendReturning({ ok: false, reason: 'error', backend: 'jev', latencyMs: 5 });
    await expect(backend.decide(REQUEST, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'error', backend: 'jev', latencyMs: 5 });
  });
});
