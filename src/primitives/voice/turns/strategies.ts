import type { TurnActivity, TurnStrategy } from './types.js';

export interface SilenceTurnStrategyOptions {
  silenceThresholdMs: number;
  interruptOnUserSpeechDuringAssistant?: boolean;
}

export interface TranscriptConfirmedTurnStrategyOptions extends SilenceTurnStrategyOptions {
  requireFinalTranscript?: boolean;
}

export function createSilenceTurnStrategy(options: SilenceTurnStrategyOptions): TurnStrategy {
  const silenceThresholdMs = normalizeThreshold(options.silenceThresholdMs);

  return {
    name: 'silence-threshold',
    interruptOnUserSpeechDuringAssistant: options.interruptOnUserSpeechDuringAssistant ?? true,
    shouldCloseUserTurn(activity: TurnActivity): boolean {
      return activity.silenceMs >= silenceThresholdMs;
    },
  };
}

export function createTranscriptConfirmedTurnStrategy(
  options: TranscriptConfirmedTurnStrategyOptions,
): TurnStrategy {
  const silenceThresholdMs = normalizeThreshold(options.silenceThresholdMs);
  const requireFinalTranscript = options.requireFinalTranscript ?? true;

  return {
    name: requireFinalTranscript ? 'transcript-confirmed' : 'silence-with-transcript-hint',
    interruptOnUserSpeechDuringAssistant: options.interruptOnUserSpeechDuringAssistant ?? true,
    shouldCloseUserTurn(activity: TurnActivity): boolean {
      if (activity.silenceMs < silenceThresholdMs) {
        return false;
      }

      if (!requireFinalTranscript) {
        return true;
      }

      return activity.hasFinalTranscript;
    },
  };
}

function normalizeThreshold(silenceThresholdMs: number): number {
  if (!Number.isFinite(silenceThresholdMs) || silenceThresholdMs < 0) {
    return 0;
  }

  return silenceThresholdMs;
}
