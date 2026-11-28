import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../../shared/logger.js';
import { buildLLMWorkSpec } from '../work-spec.js';
import { runDecisionPreGate } from './pre-gate.js';
import type { DecisionOutcome } from './types.js';

const QUESTION = { type: 'noul' as const, instructions: 'Is there nothing worth remembering?' };
const SPEC = buildLLMWorkSpec({ purpose: 'decision', durable: false });

function decisions(threshold: number | null, outcome: DecisionOutcome | Error) {
  return {
    decide: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    siteSettings: () => (threshold === null ? undefined : { enabled: true, threshold }),
  };
}

function nothing(pYes: number): DecisionOutcome {
  return {
    ok: true,
    answers: { nothing_to_do: { type: 'noul', pYes } },
    backend: 'local',
    probabilitySource: 'self_report_uncalibrated',
    latencyMs: 4,
  };
}

async function gate(port: ReturnType<typeof decisions> | undefined) {
  return await runDecisionPreGate({
    decisions: port,
    siteId: 'memory.extraction_pregate',
    state: { messages: [] },
    nothingToDo: QUESTION,
    workSpec: SPEC,
  });
}

describe('runDecisionPreGate', () => {
  it('skips only when the nothing-to-do probability clears the threshold', async () => {
    await expect(gate(decisions(0.8, nothing(0.85)))).resolves.toEqual({ skip: true, pNothing: 0.85 });
    await expect(gate(decisions(0.8, nothing(0.79)))).resolves.toEqual({ skip: false, pNothing: 0.79 });
  });

  it('logs a skip at INFO with site id and pNothing, and never the gated state', async () => {
    const written = vi.spyOn(logger, 'write');
    await runDecisionPreGate({
      decisions: decisions(0.8, nothing(0.85)),
      siteId: 'memory.extraction_pregate',
      state: { messages: [{ role: 'user', text: 'private gated text' }] },
      nothingToDo: QUESTION,
      workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false, correlation: { channelId: 'dm-1' } }),
    });
    await gate(decisions(0.8, nothing(0.5)));
    const records = written.mock.calls.map(([info]) => info as Record<string, unknown>);
    written.mockRestore();
    const skips = records.filter(info => info.message === 'Decision pre-gate skipped the gated work');
    expect(skips).toEqual([expect.objectContaining({
      level: 'info', siteId: 'memory.extraction_pregate', channelId: 'dm-1', pNothing: 0.85, threshold: 0.8, backend: 'local',
    })]);
    expect(JSON.stringify(records)).not.toContain('private gated text');
  });

  it('runs the work without a decision when disabled or unwired', async () => {
    const off = decisions(null, nothing(1));
    await expect(gate(off)).resolves.toEqual({ skip: false });
    expect(off.decide).not.toHaveBeenCalled();
    await expect(gate(undefined)).resolves.toEqual({ skip: false });
  });

  it('runs the work when the decision fails or throws, and reports both', async () => {
    const written = vi.spyOn(logger, 'write');
    await expect(gate(decisions(0.5, { ok: false, reason: 'error', backend: 'local', latencyMs: 1 })))
      .resolves.toEqual({ skip: false });
    await expect(gate(decisions(0.5, new Error('boom')))).resolves.toEqual({ skip: false });
    const warnings = written.mock.calls.map(([info]) => info as Record<string, unknown>)
      .filter(info => info.level === 'warn');
    written.mockRestore();
    expect(warnings).toEqual([
      expect.objectContaining({
        message: 'Decision pre-gate returned no usable answer; running the gated work',
        siteId: 'memory.extraction_pregate', backend: 'local', reason: 'error',
      }),
      expect.objectContaining({
        message: 'Decision pre-gate failed; running the gated work',
        siteId: 'memory.extraction_pregate', errorName: 'Error',
      }),
    ]);
  });
});
