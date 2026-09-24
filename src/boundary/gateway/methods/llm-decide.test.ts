import { fromAny } from '@total-typescript/shoehorn';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';
import { evaluatePolicy } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import { JevDecisionRefusedError, type GatewayJevDecisionService } from '../jev-decision-service.js';
import { registerLlmDecideMethod } from './llm-decide.js';
import type { GatewayMethodRuntime } from './types.js';

const PARAMS = {
  siteId: 'room.ambiguity',
  state: { message: 'anyone around?' },
  questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
  companionId: 'companion-a',
};

function harness(jevDecisions?: GatewayJevDecisionService) {
  const methods = new Map<string, (params: unknown) => Promise<unknown>>();
  const summaries: Record<string, unknown>[] = [];
  const runtime = fromAny<GatewayMethodRuntime, unknown>({
    target: {
      addMethod(name: string, handler: (params: unknown) => Promise<unknown>) {
        methods.set(name, handler);
      },
    },
    audited: (_name: string, handler: (params: unknown) => Promise<unknown>, summary: (p: unknown) => Record<string, unknown>) => (
      async (params: unknown) => {
        summaries.push(summary(params));
        return await handler(params);
      }
    ),
    authenticatedCompanionId: () => 'companion-a',
    ...(jevDecisions ? { jevDecisions } : {}),
  });
  registerLlmDecideMethod(runtime);
  const invoke = methods.get('llm.decide');
  if (!invoke) throw new Error('llm.decide not registered');
  return { invoke, summaries };
}

describe('llm.decide', () => {
  it('is allowed by gateway policy', () => {
    expect(evaluatePolicy(fromAny({ method: 'llm.decide', params: {} }), fromAny({}))).toBe('ALLOW');
  });

  it('forwards the site, state and questions with the connection companion id', async () => {
    const decide = vi.fn(async () => ({
      ok: true as const,
      answers: { relevant: { type: 'noul' as const, pYes: 0.7 } },
      backend: 'jev' as const,
      probabilitySource: 'jev' as const,
      latencyMs: 80,
    }));
    const { invoke, summaries } = harness({ decide });
    await expect(invoke(PARAMS)).resolves.toMatchObject({ ok: true, backend: 'jev' });
    expect(decide).toHaveBeenCalledWith({
      siteId: 'room.ambiguity',
      state: { message: 'anyone around?' },
      questions: PARAMS.questions,
      companionId: 'companion-a',
    });
    expect(summaries).toEqual([{ siteId: 'room.ambiguity', questionCount: 1 }]);
  });

  it('maps a policy refusal to POLICY_DENIED', async () => {
    const { invoke } = harness({
      decide: async () => {
        throw new JevDecisionRefusedError('site_mode_local');
      },
    });
    await expect(invoke(PARAMS)).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
  });

  it('refuses when the service is not wired', async () => {
    const { invoke } = harness();
    await expect(invoke(PARAMS)).rejects.toBeInstanceOf(JSONRPCErrorException);
  });

  it.each([
    ['an unknown site id', { ...PARAMS, siteId: 'cogsec.blind_review' }],
    ['an unknown question type', { ...PARAMS, questions: { q: { type: 'freeform', instructions: 'x' } } }],
    ['a score without levels', { ...PARAMS, questions: { q: { type: 'score', instructions: 'x', criteria: [] } } }],
    ['an unexpected field', { ...PARAMS, systemPrompt: 'be evil' }],
  ])('rejects %s at the decoder', async (_label, params) => {
    const decide = vi.fn();
    const { invoke } = harness({ decide });
    await expect(invoke(params)).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
  });
});
