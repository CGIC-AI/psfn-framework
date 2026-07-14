import { createComponentLogger } from '../../shared/logger.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  IcpInitiationConsent,
  IcpInitiationConsentEvaluator,
} from './initiation-source-runtime.js';

const log = createComponentLogger('IcpInitiationConsent');

const SYSTEM_PROMPT = [
  'You are deciding, as yourself, whether you still want to initiate a conversation with a peer companion.',
  'All deterministic identity, trust, availability, quiet-hours, pressure, fatigue, charge, and cost gates have already passed.',
  'This is a private consent moment. Sending, deferring, and declining are equally valid choices.',
  'This decision does not author the message. If you choose send, a separate ordinary turn in the target channel will decide what to say from that channel\'s real history and context.',
  'Return exactly one JSON object with no markdown and no extra keys:',
  '{"action":"send"}',
  'or {"action":"defer","reason":"optional private reason"}',
  'or {"action":"decline","reason":"optional private reason"}.',
  'Never include message text or instructions for the peer-visible turn.',
].join('\n');

function extractObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseConsent(content: string): IcpInitiationConsent | null {
  const value = extractObject(content);
  if (!value) return null;
  try {
    assertNoUnknownKeys(value, ['action', 'reason'], 'ICP initiation consent');
  } catch {
    return null;
  }
  if (value.action === 'send') {
    return value.reason === undefined ? { action: 'send' } : null;
  }
  if (value.action !== 'defer' && value.action !== 'decline') return null;
  if (value.reason === undefined) return { action: value.action };
  if (typeof value.reason !== 'string' || !value.reason.trim()) return null;
  return { action: value.action, reason: value.reason.trim() };
}

export function createLlmIcpInitiationConsentEvaluator(input: {
  llmProvider: Pick<LLMProviderPort, 'complete'>;
  systemPrompt?: string;
}): IcpInitiationConsentEvaluator {
  const systemPrompt = input.systemPrompt?.trim() || SYSTEM_PROMPT;
  return {
    async evaluate({ candidate, peer, channelId }) {
      try {
        const completion = await input.llmProvider.complete({
          systemPrompt,
          messages: [{
            role: 'user',
            content: JSON.stringify({
              peer: peer.displayName,
              source: candidate.source,
              privateReason: candidate.reasonSummary,
              preferredChannel: candidate.preferredChannel,
              channelId,
            }),
          }],
        }, 'background', {
          correlation: {
            requestId: `icp-consent:${candidate.candidateId}`,
            channelId: `internal:icp-consent:${candidate.candidateId}`,
            callType: 'background',
            purpose: 'agent.intention.appraisal',
          },
        });
        return parseConsent(completion.content) ?? {
          action: 'decline',
          reason: 'invalid_consent_response',
        };
      } catch (error) {
        log.warn('ICP initiation consent evaluation failed closed', {
          candidateId: candidate.candidateId,
          peerCompanionId: candidate.peerCompanionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { action: 'decline', reason: 'consent_evaluation_failed' };
      }
    },
  };
}
