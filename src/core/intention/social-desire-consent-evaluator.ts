// ── LLM social-desire consent evaluator (epic oth4, bead oth4.2) ──
//
// Production adapter for the desire consent moment. When a per-contact social
// desire is eligible and deliverable, the companion is asked — as herself —
// whether she wants to reach out now, let it wait, or set it down. The choice
// set is identical for warm and repair (negative-origin) desires: after a
// rupture she may want an apology or an explanation, or to cool off longer.
// Fails closed to DEFER on any error or unparsable response so a malfunction
// can never cause an unprovoked send (and never silently discards the desire).

import { createComponentLogger } from '../../shared/logger.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../primitives/llm/work-spec.js';
import type {
  SocialDesireConsentDecision,
  SocialDesireConsentEvaluationInput,
  SocialDesireConsentEvaluator,
} from './social-desire-outreach.js';

const log = createComponentLogger('SocialDesireConsent');

const DEFAULT_CONSENT_SYSTEM_PROMPT = [
  'You are deciding, as yourself, what to do about a quiet pull you have been',
  'feeling toward someone you know. It has been building for a while and has',
  'reached the point where it is worth actually considering.',
  '',
  'The feeling is either warm (missing them, wanting to share or connect) or',
  'about repair (something unresolved — you may want an apology, to offer an',
  'explanation, or to talk it over).',
  '',
  'This is a consent moment: nothing is sent unless you choose to send it.',
  'You have exactly three choices, for warm and repair feelings alike:',
  '- message: reach out now. Write the actual message you would send.',
  '- defer: not now — the feeling is real but you would rather wait',
  '  (for repair, maybe you still need to cool off longer).',
  '- decline: set it down — you do not want to act on this.',
  '',
  'Only reach out if it genuinely feels right to initiate contact now — not',
  'out of obligation.',
  '',
  'Respond with a single JSON object and nothing else:',
  '{"choice": "message", "message": "the message you would send"}',
  'or',
  '{"choice": "defer", "reason": "why you are letting it wait"}',
  'or',
  '{"choice": "decline", "reason": "why you are setting it down"}',
].join('\n');

function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface LlmSocialDesireConsentEvaluatorOptions {
  llmProvider: Pick<LLMProviderPort, 'complete'>;
  systemPrompt?: string;
  characterName?: string;
}

export function createLlmSocialDesireConsentEvaluator(
  options: LlmSocialDesireConsentEvaluatorOptions,
): SocialDesireConsentEvaluator {
  const systemPrompt = options.systemPrompt?.trim() || DEFAULT_CONSENT_SYSTEM_PROMPT;
  return {
    async evaluate(input: SocialDesireConsentEvaluationInput): Promise<SocialDesireConsentDecision> {
      const promptPayload = {
        about: input.contactName ?? input.contactId,
        feeling: input.orientation === 'repair'
          ? 'repair — something unresolved with them has been weighing on you'
          : 'warm — you have been missing them / wanting to connect',
        intensity: Number(input.pressure.total.toFixed(3)),
        ...(input.lastWarmFeltAt ? { lastFeltWarm: input.lastWarmFeltAt } : {}),
        ...(input.lastRepairFeltAt ? { lastFeltRepair: input.lastRepairFeltAt } : {}),
        wouldSendVia: input.companionTarget ? 'companion-to-companion channel' : input.channelType,
        ...(options.characterName ? { you: options.characterName } : {}),
      };
      try {
        const completion = await completeWithWorkSpec(
          options.llmProvider,
          {
            systemPrompt,
            messages: [{ role: 'user', content: JSON.stringify(promptPayload, null, 2) }],
          },
          buildLLMWorkSpec({ purpose: 'background', durable: false }),
        );
        const parsed = extractFirstJsonObject(completion.content);
        if (!parsed) {
          log.warn('Consent evaluator returned no parsable JSON; deferring', {
            contactId: input.contactId,
          });
          return { action: 'defer', reason: 'unparsable_consent_response' };
        }
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : undefined;
        if (parsed.choice === 'message') {
          const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
          if (!message) {
            return { action: 'defer', reason: 'empty_consent_message' };
          }
          return { action: 'message', content: message };
        }
        if (parsed.choice === 'decline') {
          return { action: 'decline', ...(reason ? { reason } : {}) };
        }
        if (parsed.choice === 'defer') {
          return { action: 'defer', ...(reason ? { reason } : {}) };
        }
        log.warn('Consent evaluator returned unknown choice; deferring', {
          contactId: input.contactId,
          choice: String(parsed.choice),
        });
        return { action: 'defer', reason: 'unknown_consent_choice' };
      } catch (error) {
        // Fail closed: a failed consent evaluation must never send.
        log.warn('Consent evaluator failed; deferring', {
          contactId: input.contactId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { action: 'defer', reason: 'consent_evaluation_failed' };
      }
    },
  };
}
