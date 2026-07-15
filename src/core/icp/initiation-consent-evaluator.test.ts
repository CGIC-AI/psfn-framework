import { describe, expect, it, vi } from 'vitest';

import { createLlmIcpInitiationConsentEvaluator } from './initiation-consent-evaluator.js';
import type { IcpInitiationCandidate } from './initiation-candidate.js';

const candidate: IcpInitiationCandidate = {
  candidateId: '11111111-1111-4111-8111-111111111111',
  rootInitiationId: '11111111-1111-4111-8111-111111111111',
  localCompanionId: '22222222-2222-4222-8222-222222222222',
  peerContactId: 'peer-contact',
  peerCompanionId: '33333333-3333-4333-8333-333333333333',
  preferredChannel: 'dm',
  source: 'free_time',
  provenanceRef: 'icp-prov:44444444-4444-4444-8444-444444444444',
  reasonSummary: 'I would like to catch up.',
  createdAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_003_600_000,
  status: 'pending',
  revision: 1,
};

function input() {
  return {
    candidate,
    peer: {
      contactId: 'peer-contact',
      displayName: 'Peer',
      peerCompanionId: candidate.peerCompanionId,
    },
    channelId: `companion-dm:${candidate.localCompanionId}:${candidate.peerCompanionId}`,
  };
}

describe('ICP initiation consent evaluator', () => {
  it.each([
    ['{"action":"send"}', { action: 'send' }],
    ['{"action":"defer","reason":"later"}', { action: 'defer', reason: 'later' }],
    ['{"action":"decline","reason":"no"}', { action: 'decline', reason: 'no' }],
  ] as const)('parses structured %s without accepting peer-visible text', async (content, expected) => {
    const complete = vi.fn().mockResolvedValue({ content });
    const evaluator = createLlmIcpInitiationConsentEvaluator({ llmProvider: { complete } });

    await expect(evaluator.evaluate(input())).resolves.toEqual(expected);
    const prompt = complete.mock.calls[0]![0];
    expect(prompt.systemPrompt).toContain('does not author the message');
    expect(JSON.stringify(prompt)).toContain(candidate.reasonSummary);
  });

  it.each([
    'not json',
    '{"action":"send","message":"bypass"}',
    '{"action":"unknown"}',
    'Sure: {"action":"send"}',
    '```json\n{"action":"send"}\n```',
  ])(
    'fails closed on malformed or message-authoring output: %s',
    async (content) => {
      const evaluator = createLlmIcpInitiationConsentEvaluator({
        llmProvider: { complete: vi.fn().mockResolvedValue({ content }) },
      });
      await expect(evaluator.evaluate(input())).resolves.toEqual({
        action: 'decline',
        reason: 'invalid_consent_response',
      });
    },
  );

  it('fails closed when the model provider errors', async () => {
    const evaluator = createLlmIcpInitiationConsentEvaluator({
      llmProvider: { complete: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    await expect(evaluator.evaluate(input())).resolves.toEqual({
      action: 'decline',
      reason: 'consent_evaluation_failed',
    });
  });
});
