/**
 * Deterministic voice transport-control intents (psfn-framework-mmo9.7.5).
 *
 * Voice transport controls — stop / interrupt / repeat — are handled locally
 * and deterministically at the transport layer with ZERO model invocations.
 * Detection is exact/local: a normalized utterance is matched against fixed
 * phrase sets. No classifier and no model call ever decides that an utterance
 * is a control command.
 *
 * Matching is exact on the WHOLE normalized utterance (never substring) so
 * ordinary speech that merely contains a control word — "stop by the store
 * later", "say hi to her again" — is never misread as a transport control and
 * still reaches the model. This is intentionally conservative: an unmatched
 * utterance falls through to the normal model turn (fail open toward the model
 * for content, fail closed toward zero-model handling only on an exact match).
 */

export type VoiceControlIntent = 'stop' | 'interrupt' | 'repeat';

/**
 * "Stop / cancel the response" — the companion should fall silent and produce
 * no reply for this utterance.
 */
const STOP_PHRASES: ReadonlySet<string> = new Set([
  'stop',
  'stop it',
  'stop stop',
  'stop talking',
  'be quiet',
  'quiet',
  'shush',
  'hush',
  'shut up',
  'cancel',
  'cancel that',
  'enough',
  'thats enough',
  'that is enough',
  'never mind',
  'nevermind',
]);

/**
 * "Hold / interrupt" — barge-in framed as a spoken pause. Handled identically
 * to stop at the transport layer (cancel current, no model turn); kept as a
 * distinct intent for telemetry/labeling.
 */
const INTERRUPT_PHRASES: ReadonlySet<string> = new Set([
  'wait',
  'wait wait',
  'hold on',
  'hold up',
  'hang on',
  'pause',
  'one moment',
  'one second',
  'just a moment',
  'just a second',
  'wait a moment',
  'wait a second',
]);

/**
 * "Say that again" — replay the last spoken utterance verbatim, no new model
 * turn.
 */
const REPEAT_PHRASES: ReadonlySet<string> = new Set([
  'repeat',
  'repeat that',
  'say that again',
  'say it again',
  'say again',
  'come again',
  'one more time',
  'again',
  'what did you say',
  'what was that',
  'can you repeat that',
  'could you repeat that',
  'can you say that again',
  'pardon',
]);

const LEADING_FILLER = /^(please|hey|okay|ok|um|uh|so|well)\s+/;
const TRAILING_FILLER = /\s+(please|now|thanks)$/;

/**
 * Normalize an utterance for exact control-phrase matching: lowercase, drop
 * apostrophes ("that's" -> "thats"), collapse every other non-alphanumeric run
 * to a single space, and strip edge politeness fillers so "hey stop please" and
 * "stop" both normalize to "stop". Deterministic and allocation-cheap.
 */
export function normalizeVoiceControlText(text: string): string {
  let normalized = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim();
  } while (normalized !== previous && normalized.length > 0);

  return normalized;
}

/**
 * Classify an utterance as a deterministic transport-control intent, or null
 * when it is ordinary content that must reach the model. Exact whole-utterance
 * match only.
 */
export function classifyVoiceControlIntent(text: string): VoiceControlIntent | null {
  const normalized = normalizeVoiceControlText(text);
  if (!normalized) return null;
  if (STOP_PHRASES.has(normalized)) return 'stop';
  if (INTERRUPT_PHRASES.has(normalized)) return 'interrupt';
  if (REPEAT_PHRASES.has(normalized)) return 'repeat';
  return null;
}
