import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { LLMResponse } from '../../shared/contracts/runtime.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';
import { DEFAULT_INTROSPECTION_AUDIT_CONFIG } from '../../system/config/scheduler-config.js';
import type { IntrospectionAuditCandidate } from './contracts.js';
import {
  createLLMCompanionLandmarkReflector,
  createLLMIntrospectionAuditor,
} from './model-runtime.js';

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 5,
    stopReason: 'stop',
  };
}

const CANDIDATE: IntrospectionAuditCandidate = {
  sourceRef: 'turn:source-turn',
  turnId: 'source-turn',
  channelId: 'discord:source-channel',
  occurredAt: '2026-07-13T10:00:00.000Z',
  publicStimulus: 'Please choose a plan.',
  actualReply: 'I choose the first plan.',
  provenanceRefs: ['turn:source-turn', 'request:source-request'],
};

describe('introspection model telemetry', () => {
  it('classifies every auditor and reflection call as generic companion-private background work', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify({ stableReply: 'I would compare the plans.' })))
      .mockResolvedValueOnce(response(JSON.stringify({
        diverged: true,
        type: 'substantive',
        observation: 'The choice arrived before comparison.',
        confidence: 0.9,
      })))
      .mockResolvedValueOnce(response(JSON.stringify({ reflection: 'I want to compare before choosing.' })));
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(),
      complete,
    };
    const config = { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true };
    const auditor = createLLMIntrospectionAuditor(llmProvider, config);
    const reflector = createLLMCompanionLandmarkReflector(llmProvider, 'private companion prompt', config);

    const stable = await auditor.estimateStableReply(CANDIDATE);
    const comparison = await auditor.compareReplies(CANDIDATE, stable.stableReply);
    await reflector.reflect({
      divergenceType: comparison.type ?? 'substantive',
      observation: comparison.observation,
      confidence: comparison.confidence,
    });

    expect(complete).toHaveBeenCalledTimes(3);
    for (const call of complete.mock.calls) {
      expect(call[2]?.correlation).toEqual(COMPANION_PRIVATE_BACKGROUND_TELEMETRY);
      expect(call[2]?.correlation).not.toHaveProperty('turnId');
      expect(call[2]?.correlation).not.toHaveProperty('requestId');
      expect(call[2]?.correlation).not.toHaveProperty('channelId');
    }
  });
});
