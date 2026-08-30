import { hasExactKeys, isRecord } from '../utils/types.js';
import type { CompanionId } from '../routing/companion-id.js';

export const COMPANION_UI_AUDIO_OUTPUT_PATH = '/v1/companion/audio-output';

/**
 * Authenticated Hub source for one browser-bound spoken-audio stream.
 * Every field is server-resolved from the satellite claim; the request body
 * never selects a recipient or supplies routing authority.
 */
export interface CompanionUiAudioOutputBinding {
  readonly companionId: CompanionId;
  readonly principalId: string;
  readonly satelliteId: string;
  readonly endpointId: string;
  readonly claimType: string;
  readonly sessionId: string;
}

/** Exact retained Hub frames the gateway may forward to Companion UI. */
export type CompanionUiAudioOutputFrame =
  | Readonly<{ type: 'text'; data: 'audio-init' | 'audio-end' }>
  | Readonly<{ type: 'audio'; data: string }>
  | Readonly<{ type: 'assistant.interrupted'; sessionId: string }>
  | Readonly<{ type: 'action'; data: 'interrupt' | 'pause-audio' }>;

export function companionUiAudioOutputBindingKey(
  binding: CompanionUiAudioOutputBinding,
): string {
  return JSON.stringify([
    binding.companionId,
    binding.principalId,
    binding.satelliteId,
    binding.endpointId,
    binding.claimType,
    binding.sessionId,
  ]);
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

/**
 * Strictly parse the Hub's browser-audio subset. The authenticated claim owns
 * session identity; an interruption frame may repeat it only when it matches.
 */
export function parseCompanionUiAudioOutputFrame(
  value: unknown,
  expectedSessionId: string,
): CompanionUiAudioOutputFrame {
  if (!isRecord(value)) throw new Error('Companion UI audio output frame must be an object');
  if (value.type === 'text'
    && hasExactKeys(value, ['type', 'data'])
    && (value.data === 'audio-init' || value.data === 'audio-end')) {
    return Object.freeze({ type: 'text', data: value.data });
  }
  if (value.type === 'audio'
    && hasExactKeys(value, ['type', 'data'])
    && isCanonicalBase64(value.data)) {
    return Object.freeze({ type: 'audio', data: value.data });
  }
  if (value.type === 'assistant.interrupted'
    && hasExactKeys(value, ['type', 'sessionId'])
    && value.sessionId === expectedSessionId) {
    return Object.freeze({ type: 'assistant.interrupted', sessionId: expectedSessionId });
  }
  if (value.type === 'action'
    && hasExactKeys(value, ['type', 'data'])
    && (value.data === 'interrupt' || value.data === 'pause-audio')) {
    return Object.freeze({ type: 'action', data: value.data });
  }
  throw new Error('Companion UI audio output frame is malformed');
}
