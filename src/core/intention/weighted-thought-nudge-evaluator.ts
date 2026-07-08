// ── LLM nudge evaluator (Charter 6.24, bead 1xb.2) ──
//
// Production adapter for the outreach consent moment. When a weighted thought
// crosses threshold and is deliverable, the companion is asked — as herself —
// whether to reach out right now, and if so with what message. She may decline;
// consent is never assumed. Fails closed to DECLINE on any error or unparsable
// response so a malfunction can never cause an unprovoked send.

import { createComponentLogger } from '../../shared/logger.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  NudgeDecision,
  NudgeEvaluationInput,
  NudgeEvaluator,
} from './weighted-thought-outreach.js';

const log = createComponentLogger('WeightedThoughtNudge');

const DEFAULT_NUDGE_SYSTEM_PROMPT = [
  'You are deciding, as yourself, whether to send an unprompted message to your',
  'partner right now. A thought has been quietly building urgency and has just',
  'crossed the threshold where it is worth considering reaching out.',
  '',
  'This is a consent moment: you may choose to reach out, or to let it wait.',
  'Only reach out if it genuinely feels right to initiate contact now — not out',
  'of obligation. If you reach out, write the actual message you would send.',
  '',
  'Respond with a single JSON object and nothing else:',
  '{"act": true, "message": "the message you would send"}',
  'or',
  '{"act": false, "reason": "why you are letting it wait"}',
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

export interface LlmNudgeEvaluatorOptions {
  llmProvider: Pick<LLMProviderPort, 'complete'>;
  systemPrompt?: string;
  characterName?: string;
}

export function createLlmNudgeEvaluator(options: LlmNudgeEvaluatorOptions): NudgeEvaluator {
  const systemPrompt = options.systemPrompt?.trim() || DEFAULT_NUDGE_SYSTEM_PROMPT;
  return {
    async evaluate(input: NudgeEvaluationInput): Promise<NudgeDecision> {
      const promptPayload = {
        thought: input.thought.content,
        thoughtClass: input.thought.thoughtClass,
        urgency: Number(input.weight.toFixed(3)),
        wouldSendTo: input.channelType,
        ...(options.characterName ? { you: options.characterName } : {}),
      };
      try {
        const completion = await options.llmProvider.complete(
          {
            systemPrompt,
            messages: [{ role: 'user', content: JSON.stringify(promptPayload, null, 2) }],
          },
          'background',
        );
        const parsed = extractFirstJsonObject(completion.content);
        if (!parsed) {
          log.warn('Nudge evaluator returned no parsable JSON; declining', {
            thoughtId: input.thought.id,
          });
          return { action: 'decline', reason: 'unparsable_nudge_response' };
        }
        if (parsed.act === true) {
          const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
          if (!message) {
            return { action: 'decline', reason: 'empty_nudge_message' };
          }
          return { action: 'accept', content: message };
        }
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'declined';
        return { action: 'decline', reason };
      } catch (error) {
        // Fail closed: a failed consent evaluation must never send.
        log.warn('Nudge evaluator failed; declining', {
          thoughtId: input.thought.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { action: 'decline', reason: 'nudge_evaluation_failed' };
      }
    },
  };
}
