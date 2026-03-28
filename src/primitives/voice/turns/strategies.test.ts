import { describe, expect, it } from 'vitest';
import {
  createSilenceTurnStrategy,
  createTranscriptConfirmedTurnStrategy,
} from './strategies.js';

describe('createSilenceTurnStrategy', () => {
  it('closes turn once silence threshold is met', () => {
    const strategy = createSilenceTurnStrategy({ silenceThresholdMs: 300 });

    expect(strategy.shouldCloseUserTurn({ silenceMs: 299, hasFinalTranscript: false })).toBe(false);
    expect(strategy.shouldCloseUserTurn({ silenceMs: 300, hasFinalTranscript: false })).toBe(true);
  });
});

describe('createTranscriptConfirmedTurnStrategy', () => {
  it('requires a final transcript when configured', () => {
    const strategy = createTranscriptConfirmedTurnStrategy({
      silenceThresholdMs: 200,
      requireFinalTranscript: true,
    });

    expect(strategy.shouldCloseUserTurn({ silenceMs: 250, hasFinalTranscript: false })).toBe(false);
    expect(strategy.shouldCloseUserTurn({ silenceMs: 250, hasFinalTranscript: true })).toBe(true);
  });

  it('falls back to silence-only behavior when final transcript is optional', () => {
    const strategy = createTranscriptConfirmedTurnStrategy({
      silenceThresholdMs: 200,
      requireFinalTranscript: false,
    });

    expect(strategy.shouldCloseUserTurn({ silenceMs: 250, hasFinalTranscript: false })).toBe(true);
  });
});
