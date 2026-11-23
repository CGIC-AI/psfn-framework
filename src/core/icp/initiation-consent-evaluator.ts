import { createComponentLogger } from '../../shared/logger.js';
import { assertNoUnknownKeys } from '../../shared/utils/types.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import { completeSealedJsonObject } from '../../primitives/llm/sealed-json-runner.js';
import type {
  IcpInitiationConsent,
  IcpInitiationConsentEvaluator,
} from './initiation-source-runtime.js';

const log = createComponentLogger('IcpInitiationConsent');

const SYSTEM_PROMPT = [
  'You are deciding, as yourself, whether you still want to initiate a conversation with a peer companion.',
  'All deterministic identity, trust, availability, quiet-hours, pressure, fatigue, charge, and cost gates have already passed.',
  'This is a private consent moment. Sending, deferring, and declining are equally valid choices.',
  'This decision does not author the message. If you choose send, either your already-authored message or an ordinary turn in the target channel will speak to the peer.',
  'Return exactly one JSON object with no extra keys:',
  '{"action":"send"}',
  'or {"action":"send","reason":"optional private reason"}',
  'or {"action":"defer","reason":"optional private reason"}',
  'or {"action":"decline","reason":"optional private reason"}.',
  'Never include message text or instructions for the peer-visible turn.',
].join('\n');

function validateConsentObject(value: Record<string, unknown>): IcpInitiationConsent | null {
  try {
    assertNoUnknownKeys(value, ['action', 'reason'], 'ICP initiation consent');
  } catch {
    return null;
  }
  if (value.action !== 'send' && value.action !== 'defer' && value.action !== 'decline') {
    return null;
  }
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
        const { parsed: rawObject } = await completeSealedJsonObject({
          llmProvider: input.llmProvider,
          label: 'ICP initiation consent',
          systemPrompt,
          payload: {
            peer: peer.displayName,
            source: candidate.source,
            privateReason: candidate.reasonSummary,
            preferredChannel: candidate.preferredChannel,
            channelId,
          },
          workSpec: {
            purpose: 'background',
            durable: false,
            correlation: {
              requestId: `icp-consent:${candidate.candidateId}`,
              channelId: `internal:icp-consent:${candidate.candidateId}`,
              callType: 'background',
              purpose: 'agent.intention.appraisal',
            },
          },
          allowMarkdownFence: true,
        });
        const parsed = validateConsentObject(rawObject);
        if (!parsed) {
          log.warn('ICP initiation consent response was malformed; deferring without fatigue penalty', {
            candidateId: candidate.candidateId,
            peerCompanionId: candidate.peerCompanionId,
          });
          return {
            action: 'defer',
            reason: 'invalid_consent_response',
          };
        }
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isMalformed = message.includes('malformed JSON') || message.includes('must return a JSON object');
        log.warn(
          isMalformed
            ? 'ICP initiation consent response was malformed; deferring without fatigue penalty'
            : 'ICP initiation consent evaluation failed; deferring without fatigue penalty',
          {
            candidateId: candidate.candidateId,
            peerCompanionId: candidate.peerCompanionId,
            ...(isMalformed ? {} : { error: message }),
          },
        );
        return {
          action: 'defer',
          reason: isMalformed ? 'invalid_consent_response' : 'consent_evaluation_failed',
        };
      }
    },
  };
}
