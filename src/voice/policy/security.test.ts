import { describe, expect, it } from 'vitest';
import {
  VoiceSecurityError,
  assertBoundedBytes,
  assertBoundedText,
  resolveVoiceSecurityLimits,
  validatePcmAudio,
  validateTranscriptText,
  validateTtsAudioChunk,
  validateTtsInputText,
} from './security.js';

describe('voice security policy', () => {
  it('validates bounded byte payloads', () => {
    expect(() => assertBoundedBytes('audio', new Uint8Array([1, 2, 3]), 3)).not.toThrow();
    expect(() => assertBoundedBytes('audio', new Uint8Array([1, 2, 3, 4]), 3)).toThrow(VoiceSecurityError);
  });

  it('trims and validates bounded text payloads', () => {
    const text = assertBoundedText('transcript', '  hello  ', 32);
    expect(text).toBe('hello');

    expect(() => assertBoundedText('transcript', 'x'.repeat(40), 16)).toThrow(VoiceSecurityError);
  });

  it('enforces per-field limits through helpers', () => {
    const limits = resolveVoiceSecurityLimits({
      maxPcmBytes: 8,
      maxTranscriptChars: 12,
      maxTtsChars: 10,
      maxTtsAudioBytes: 9,
    });

    expect(() => validatePcmAudio(new Uint8Array(8), limits)).not.toThrow();
    expect(() => validatePcmAudio(new Uint8Array(9), limits)).toThrow(VoiceSecurityError);

    expect(validateTranscriptText('small', limits)).toBe('small');
    expect(() => validateTranscriptText('this transcript is too long', limits)).toThrow(VoiceSecurityError);

    expect(validateTtsInputText('reply', limits)).toBe('reply');
    expect(() => validateTtsInputText('this is too long', limits)).toThrow(VoiceSecurityError);

    const totalAfterFirst = validateTtsAudioChunk(new Uint8Array([1, 2, 3]), 0, limits);
    expect(totalAfterFirst).toBe(3);
    expect(() => validateTtsAudioChunk(new Uint8Array([4, 5, 6, 7, 8, 9, 10]), totalAfterFirst, limits)).toThrow(VoiceSecurityError);
  });
});
