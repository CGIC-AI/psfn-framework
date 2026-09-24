import { describe, expect, it, vi } from 'vitest';
import { buildLLMWorkSpec } from '../work-spec.js';
import { createDecisionRuntime } from './decide.js';
import type { LocalDecisionBackend } from './local-backend.js';
import type { DecisionOutcome, DecisionRequest } from './types.js';

const LOCAL_OUTCOME: DecisionOutcome = {
  ok: true,
  answers: { relevant: { type: 'noul', pYes: 0.8 } },
  backend: 'local',
  probabilitySource: 'self_report_uncalibrated',
  latencyMs: 3,
};

function makeRequest(): DecisionRequest {
  return {
    site: { id: 'room.ambiguity', privacy: 'shareable' },
    state: { message: 'anyone around?' },
    questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
    workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false }),
  };
}

describe('createDecisionRuntime (local only)', () => {
  it('answers through the generic local backend', async () => {
    const local: LocalDecisionBackend = { decide: vi.fn(async () => LOCAL_OUTCOME) };
    const runtime = createDecisionRuntime({ local });
    await expect(runtime.decide(makeRequest())).resolves.toEqual(LOCAL_OUTCOME);
    expect(local.decide).toHaveBeenCalledTimes(1);
  });

  it('uses the site local strategy instead of the generic backend when given', async () => {
    const local: LocalDecisionBackend = { decide: vi.fn(async () => LOCAL_OUTCOME) };
    const siteOutcome: DecisionOutcome = { ...LOCAL_OUTCOME, latencyMs: 9 };
    const runtime = createDecisionRuntime({ local });
    await expect(runtime.decide(makeRequest(), { localStrategy: async () => siteOutcome }))
      .resolves.toBe(siteOutcome);
    expect(local.decide).not.toHaveBeenCalled();
  });
});
