import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  ActiveConcernSnapshot,
  AppraisalTrigger,
} from './types.js';

export function isBackgroundAppraisalChannel(channelId: string): boolean {
  return channelId.startsWith('internal:');
}

export function maxEmotionShift(
  previous: EmotionStateSnapshot | null,
  current: EmotionStateSnapshot | null,
): number {
  if (!previous || !current) return 0;
  return Math.max(
    Math.abs(current.vad.valence - previous.vad.valence),
    Math.abs(current.vad.arousal - previous.vad.arousal),
    Math.abs(current.vad.dominance - previous.vad.dominance),
    Math.abs(current.mood.valence - previous.mood.valence),
    Math.abs(current.mood.arousal - previous.mood.arousal),
    Math.abs(current.mood.dominance - previous.mood.dominance),
  );
}

export function hasDueSoonConcern(
  concerns: readonly ActiveConcernSnapshot[],
  now: number,
  dueSoonWindowMs: number,
): boolean {
  const windowEnd = now + dueSoonWindowMs;
  return concerns.some((concern) => (
    typeof concern.dueAt === 'number'
    && Number.isFinite(concern.dueAt)
    && concern.dueAt > 0
    && concern.dueAt <= windowEnd
    && concern.status !== 'resolved'
  ));
}

export function classifyAppraisalTrigger(input: {
  triggerOverride: 'motivation' | null;
  emotionalShift: number;
  emotionalShiftThreshold: number;
  concernDueSoon: boolean;
  turnsSinceLast: number;
  appraisalFrequency: number;
}): AppraisalTrigger | null {
  return (
    input.triggerOverride
    ?? (input.emotionalShift >= input.emotionalShiftThreshold
      ? 'emotional_shift'
      : input.concernDueSoon
        ? 'concern_due'
        : input.turnsSinceLast >= input.appraisalFrequency
          ? 'frequency'
          : null)
  );
}
