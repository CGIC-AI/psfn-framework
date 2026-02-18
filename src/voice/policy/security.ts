export interface VoiceSecurityLimits {
  maxPcmBytes: number;
  maxTranscriptChars: number;
  maxTtsChars: number;
  maxTtsAudioBytes: number;
}

export const DEFAULT_VOICE_SECURITY_LIMITS: VoiceSecurityLimits = {
  maxPcmBytes: 8 * 1024 * 1024,
  maxTranscriptChars: 4_000,
  maxTtsChars: 3_000,
  maxTtsAudioBytes: 24 * 1024 * 1024,
};

export class VoiceSecurityError extends Error {
  readonly field: string;
  readonly actualSize: number;
  readonly maxSize: number;

  constructor(field: string, actualSize: number, maxSize: number) {
    super(`${field} exceeds safety limit (${actualSize} > ${maxSize})`);
    this.name = 'VoiceSecurityError';
    this.field = field;
    this.actualSize = actualSize;
    this.maxSize = maxSize;
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function byteLength(input: string | Uint8Array): number {
  if (typeof input === 'string') {
    return Buffer.byteLength(input, 'utf8');
  }

  return input.byteLength;
}

export function resolveVoiceSecurityLimits(overrides: Partial<VoiceSecurityLimits> = {}): VoiceSecurityLimits {
  return {
    maxPcmBytes: normalizeLimit(overrides.maxPcmBytes, DEFAULT_VOICE_SECURITY_LIMITS.maxPcmBytes),
    maxTranscriptChars: normalizeLimit(overrides.maxTranscriptChars, DEFAULT_VOICE_SECURITY_LIMITS.maxTranscriptChars),
    maxTtsChars: normalizeLimit(overrides.maxTtsChars, DEFAULT_VOICE_SECURITY_LIMITS.maxTtsChars),
    maxTtsAudioBytes: normalizeLimit(overrides.maxTtsAudioBytes, DEFAULT_VOICE_SECURITY_LIMITS.maxTtsAudioBytes),
  };
}

export function assertBoundedBytes(field: string, data: Uint8Array, maxBytes: number): void {
  const size = byteLength(data);
  if (size > maxBytes) {
    throw new VoiceSecurityError(field, size, maxBytes);
  }
}

export function assertBoundedText(field: string, text: string, maxBytes: number): string {
  const trimmed = text.trim();
  const size = byteLength(trimmed);

  if (size > maxBytes) {
    throw new VoiceSecurityError(field, size, maxBytes);
  }

  return trimmed;
}

export function validatePcmAudio(pcm: Uint8Array, limits = DEFAULT_VOICE_SECURITY_LIMITS): void {
  assertBoundedBytes('voice.pcm', pcm, limits.maxPcmBytes);
}

export function validateTranscriptText(text: string, limits = DEFAULT_VOICE_SECURITY_LIMITS): string {
  return assertBoundedText('voice.transcript', text, limits.maxTranscriptChars);
}

export function validateTtsInputText(text: string, limits = DEFAULT_VOICE_SECURITY_LIMITS): string {
  return assertBoundedText('voice.tts.text', text, limits.maxTtsChars);
}

export function validateTtsAudioChunk(
  chunk: Uint8Array,
  totalBytesSoFar: number,
  limits = DEFAULT_VOICE_SECURITY_LIMITS,
): number {
  const nextTotal = totalBytesSoFar + byteLength(chunk);

  if (nextTotal > limits.maxTtsAudioBytes) {
    throw new VoiceSecurityError('voice.tts.audio', nextTotal, limits.maxTtsAudioBytes);
  }

  return nextTotal;
}
