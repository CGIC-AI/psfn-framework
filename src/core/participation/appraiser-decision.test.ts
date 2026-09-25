import { describe, expect, it, vi } from 'vitest';
import type { LLMResponse } from '../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import {
  createDefaultDecisionBackendSettings,
  type DecisionBackendSettings,
} from '../../system/config/decision-backend-config.js';
import { createDecisionRuntime, type RemoteDecisionBackend } from '../../primitives/llm/decision/decide.js';
import type { DecisionShadowRecord } from '../../primitives/llm/decision/shadow-record.js';
import type { DecisionOutcome } from '../../primitives/llm/decision/types.js';
import { createDefaultParticipationAppraiserSettings } from '../../system/config/participation-config.js';
import { ParticipationAppraiser } from './appraiser.js';
import { buildAppraisalDecisionQuestions } from './appraiser-decision.js';
import type { ParticipationCandidate } from './types.js';

const COMPANION_NAME = 'Persephone';

function makeCandidate(overrides: Partial<ParticipationCandidate> = {}): ParticipationCandidate {
  return {
    schemaVersion: 1,
    channelId: 'discord-lounge',
    channelType: 'discord',
    sourceMessageId: 'msg-trigger',
    trigger: 'passive_name',
    triggerAuthorId: 'human-alice',
    triggerAuthorIsMachine: false,
    triggerAuthorName: 'Alice',
    triggerContent: 'I wonder what Persephone thinks about that',
    triggerTimestampMs: 1_000_000,
    matchedName: true,
    matchedDirectAddress: false,
    precedingContext: [{
      messageId: 'm1',
      authorId: 'human-bob',
      authorName: 'Bob',
      content: 'the deploy finally went green',
      timestampMs: 999_000,
    }],
    createdAtMs: 1_000_001,
    ...overrides,
  };
}

function response(content: string): LLMResponse {
  return { content, toolCalls: [], model: 'bg', inputTokens: 1, outputTokens: 1, stopReason: 'stop' };
}

function recordingProvider(content = '{"action":"reply","reasonCode":"asked","confidence":0.7}') {
  const calls: unknown[][] = [];
  const provider: Pick<LLMProviderPort, 'complete'> = {
    complete: vi.fn(async (...args: unknown[]) => {
      calls.push(args.map((arg) => structuredClone(
        arg && typeof arg === 'object' && 'signal' in arg ? { ...arg, signal: '[signal]' } : arg,
      )));
      return response(content);
    }),
  };
  return { provider, calls };
}

function jevAnswer(choice: string, probabilities: Record<string, number>, confidence?: number): DecisionOutcome {
  return {
    ok: true,
    answers: {
      action: { type: 'choice', choice, probabilities, ...(confidence !== undefined ? { confidence } : {}) },
      reaction_class: { type: 'choice', choice: 'agree' },
    },
    backend: 'jev',
    probabilitySource: 'jev',
    latencyMs: 90,
    model: 'typesafe/jev-1.13-20260917',
  };
}

function runtime(
  settings: DecisionBackendSettings | undefined,
  jev: RemoteDecisionBackend['decide'] = async () => jevAnswer('reply', { ignore: 0.1, react: 0.1, reply: 0.8 }),
) {
  const records: DecisionShadowRecord[] = [];
  const jevSpy = vi.fn(jev);
  const decisions = createDecisionRuntime({
    local: { decide: vi.fn(async () => { throw new Error('generic local backend must not run'); }) },
    jev: { decide: jevSpy },
    resolveSettings: () => settings,
    shadowSink: { record: (entry) => records.push(entry) },
  });
  return { decisions, jevSpy, records };
}

function settingsFor(mode: DecisionBackendSettings['mode'], threshold?: number): DecisionBackendSettings {
  return {
    ...createDefaultDecisionBackendSettings(),
    sites: { 'participation.appraise': { mode, ...(threshold !== undefined ? { threshold } : {}) } },
  };
}

describe('ParticipationAppraiser on decide()', () => {
  it('sends byte-identical model calls under local as without a decision runtime', async () => {
    const baseline = recordingProvider();
    await new ParticipationAppraiser({
      llmProvider: baseline.provider, companionName: COMPANION_NAME, companionId: 'c-1',
    }).appraise(makeCandidate());

    const local = recordingProvider();
    const { decisions, jevSpy } = runtime(settingsFor('local'));
    const result = await new ParticipationAppraiser({
      llmProvider: local.provider, companionName: COMPANION_NAME, companionId: 'c-1', decisions,
    }).appraise(makeCandidate());

    expect(local.calls).toEqual(baseline.calls);
    expect(result.appraisal).toEqual({ action: 'reply', reasonCode: 'asked', confidence: 0.7 });
    expect(jevSpy).not.toHaveBeenCalled();
  });

  it('answers from jev without a local model call in jev mode', async () => {
    const { provider, calls } = recordingProvider();
    const { decisions, jevSpy } = runtime(settingsFor('jev'));
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());

    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      appraisal: { action: 'reply', reasonCode: 'decision_backend', confidence: 0.8 },
      failClosed: false,
    });
    const request = jevSpy.mock.calls[0]?.[0];
    expect(request?.siteId).toBe('participation.appraise');
    expect(Object.keys(request?.questions ?? {})).toEqual(['action', 'reaction_class']);
    expect(JSON.stringify(request?.state)).toContain('I wonder what Persephone thinks about that');
  });

  it('maps a jev react to the reaction class question', async () => {
    const { provider } = recordingProvider();
    const { decisions } = runtime(settingsFor('jev'), async () => jevAnswer('react', { react: 0.9 }, 0.85));
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());
    expect(result.appraisal).toEqual({
      action: 'react', reactionClass: 'agree', reasonCode: 'decision_backend', confidence: 0.85,
    });
  });

  it('downgrades a jev action below the configured probability threshold to ignore', async () => {
    const { provider } = recordingProvider();
    const { decisions } = runtime(
      settingsFor('jev', 0.6),
      async () => jevAnswer('reply', { ignore: 0.45, react: 0, reply: 0.55 }),
    );
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());
    expect(result.appraisal).toEqual({
      action: 'ignore', reasonCode: 'decision_below_threshold', confidence: 0.55,
    });
  });

  it('never sends a private companion-dm appraisal with its history to jev (p6s1f)', async () => {
    const dmCandidate = makeCandidate({
      channelId: 'companion-dm:aaaaaaaa-0000-4000-8000-00000000000a:bbbbbbbb-0000-4000-8000-00000000000b',
      channelType: 'companion',
      participationSurface: 'companion_dm',
      trigger: 'companion_message',
      triggerContent: 'private sibling message',
      precedingContext: [{
        messageId: 'dm-1', authorId: 'peer', authorName: 'Nova',
        content: 'private sibling history', timestampMs: 999_000,
      }],
    });
    const settingsVariants: DecisionBackendSettings[] = [
      { ...createDefaultDecisionBackendSettings(), mode: 'jev' },
      { ...createDefaultDecisionBackendSettings(), mode: 'shadow' },
      settingsFor('jev'),
      {
        ...createDefaultDecisionBackendSettings(),
        mode: 'jev',
        sites: { 'participation.appraise_dm': { mode: 'jev' } },
      },
    ];
    for (const settings of settingsVariants) {
      const { provider, calls } = recordingProvider();
      const { decisions, jevSpy, records } = runtime(settings);
      const result = await new ParticipationAppraiser({
        llmProvider: provider, companionName: COMPANION_NAME, decisions,
      }).appraise(dmCandidate);
      expect(jevSpy).not.toHaveBeenCalled();
      expect(records).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0])).toContain('private sibling history');
      expect(result.appraisal).toEqual({ action: 'reply', reasonCode: 'asked', confidence: 0.7 });
    }
  });

  it('refuses to build remote questions for the private companion surface', () => {
    expect(() => buildAppraisalDecisionQuestions('companion_dm')).toThrow('companion_private');
  });

  it('falls back to the exact local appraisal when jev fails', async () => {
    const { provider, calls } = recordingProvider();
    const { decisions } = runtime(settingsFor('jev'), async () => ({
      ok: false, reason: 'error', backend: 'jev', latencyMs: 5,
    }));
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());
    expect(calls).toHaveLength(1);
    expect(result.appraisal).toEqual({ action: 'reply', reasonCode: 'asked', confidence: 0.7 });
  });

  it('keeps the fail-closed ignore when jev fails and the local call also fails', async () => {
    const provider: Pick<LLMProviderPort, 'complete'> = { complete: vi.fn(async () => response('not json')) };
    const { decisions } = runtime(settingsFor('jev'), async () => ({
      ok: false, reason: 'error', backend: 'jev', latencyMs: 5,
    }));
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());
    expect(result).toMatchObject({ appraisal: { action: 'ignore' }, failClosed: true });
  });

  it('acts on the local appraisal in shadow mode and records agreement', async () => {
    const { provider } = recordingProvider();
    const { decisions, records } = runtime(
      settingsFor('shadow'),
      async () => jevAnswer('ignore', { ignore: 0.7, react: 0.1, reply: 0.2 }),
    );
    const result = await new ParticipationAppraiser({
      llmProvider: provider, companionName: COMPANION_NAME, decisions,
    }).appraise(makeCandidate());
    expect(result.appraisal).toEqual({ action: 'reply', reasonCode: 'asked', confidence: 0.7 });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      siteId: 'participation.appraise',
      agreement: { action: false },
      local: { ok: true, answers: { action: { type: 'choice', choice: 'reply', confidence: 0.7 } } },
    });
    expect(JSON.stringify(records[0])).not.toContain('Persephone thinks');
  });

  it('never consults the decision runtime when the appraiser is disabled', async () => {
    const { provider } = recordingProvider();
    const { decisions, jevSpy } = runtime(settingsFor('jev'));
    const appraiser = new ParticipationAppraiser({
      llmProvider: provider,
      companionName: COMPANION_NAME,
      decisions,
      settings: { ...createDefaultParticipationAppraiserSettings(), enabled: false },
    });
    const result = await appraiser.appraise(makeCandidate());
    expect(result.failClosedReason).toBe('appraiser_disabled');
    expect(jevSpy).not.toHaveBeenCalled();
  });
});
