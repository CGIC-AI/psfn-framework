import { toErrorMessage } from '../../shared/utils/errors.js';
import type { StructuredVoiceError, VoiceTurnErrorStage } from './voice-types.js';
import { UNKNOWN_VOICE_ERROR_CODE } from './voice-types.js';

export function classifyVoiceTurnStatus(error: unknown): 'completed' | 'cancelled' | 'timeout' | 'error' {
  const text = toErrorMessage(error).toLowerCase();
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('cancel') || text.includes('abort') || text.includes('interrupt')) return 'cancelled';
  return 'error';
}

export function resolveVoiceErrorStage(error: unknown): VoiceTurnErrorStage {
  if (error && typeof error === 'object') {
    const stage = (error as StructuredVoiceError).voiceStage;
    if (stage) return stage;
  }

  const text = toErrorMessage(error).toLowerCase();
  if (text.includes('deepgram') || text.includes('transcrib') || text.includes('stt')) return 'stt';
  if (text.includes('elevenlabs') || text.includes('synth') || text.includes('tts') || text.includes('playback')) {
    return 'tts';
  }
  if (text.includes('silence') || text.includes('decode') || text.includes('opus')) return 'ingest';
  if (text.includes('response')) return 'llm';
  return 'unknown';
}

export function resolveVoiceErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as StructuredVoiceError).voiceCode;
    if (code) return code;
  }

  const text = toErrorMessage(error)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return text ? `VOICE_${text}` : UNKNOWN_VOICE_ERROR_CODE;
}

export function createStructuredVoiceError(params: {
  error: unknown;
  stage: VoiceTurnErrorStage;
  code: string;
}): StructuredVoiceError {
  const { error, stage, code } = params;
  if (error && typeof error === 'object') {
    const existing = error as StructuredVoiceError;
    if (existing.voiceStage && existing.voiceCode) {
      return existing;
    }
  }

  const wrapped = new Error(toErrorMessage(error)) as StructuredVoiceError;
  wrapped.voiceStage = stage;
  wrapped.voiceCode = code;
  if (error instanceof Error && error.stack) {
    wrapped.stack = error.stack;
  }
  return wrapped;
}
