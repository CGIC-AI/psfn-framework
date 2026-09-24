import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../agent/contracts.js';
import type { DecisionOutcome } from '../../../primitives/llm/decision/types.js';
import { IntentionAppraisal } from '../appraisal.js';

function provider(): { provider: LLMProviderPort; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => ({
    content: JSON.stringify({ decisions: [{ type: 'followUp', priority: 'medium', reason: 'Check in.', timing: 'soon' }] }),
    toolCalls: [],
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    stopReason: 'stop',
  }));
  return { provider: { stream: vi.fn(), complete } as unknown as LLMProviderPort, complete };
}

function decisions(threshold: number | null, pNothing: number) {
  return {
    decide: vi.fn(async (): Promise<DecisionOutcome> => ({
      ok: true,
      answers: { nothing_to_do: { type: 'noul', pYes: pNothing } },
      backend: 'local',
      probabilitySource: 'self_report_uncalibrated',
      latencyMs: 5,
    })),
    siteSettings: () => (threshold === null ? undefined : { enabled: true, threshold }),
  };
}

const INPUT = {
  sessionId: 'api:pregate',
  currentEmotion: { vad: { valence: 0, arousal: 0, dominance: 0 }, mood: { valence: 0, arousal: 0, dominance: 0 }, discrete: {}, confidence: 0.5 },
  recentMessages: [{ role: 'user' as const, content: 'ok, good night!' }],
};

describe('intention post-turn pre-gate', () => {
  it('returns a noop without the heavy appraisal when nothing-to-act-on clears the threshold', async () => {
    const { provider: llm, complete } = provider();
    const gate = decisions(0.9, 0.95);
    const result = await new IntentionAppraisal({ llmProvider: llm, appraisalFrequency: 1, decisions: gate }).evaluate(INPUT);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('noop');
    expect(complete).not.toHaveBeenCalled();
    const request = gate.decide.mock.calls[0] as unknown as [{ siteId: string; workSpec: { correlation?: { telemetryVisibility?: string } } }];
    expect(request[0].siteId).toBe('intention.post_turn_pregate');
    expect(request[0].workSpec.correlation?.telemetryVisibility).toBe('companion_private');
  });

  it('runs the appraisal below the threshold', async () => {
    const { provider: llm, complete } = provider();
    await new IntentionAppraisal({
      llmProvider: llm, appraisalFrequency: 1, decisions: decisions(0.9, 0.4),
    }).evaluate(INPUT);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('is inert when the site is not enabled', async () => {
    const { provider: llm, complete } = provider();
    const gate = decisions(null, 1);
    await new IntentionAppraisal({ llmProvider: llm, appraisalFrequency: 1, decisions: gate }).evaluate(INPUT);
    expect(gate.decide).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
