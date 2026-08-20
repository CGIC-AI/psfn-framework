import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import { toInterval } from './primitives.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const MAX_NEAR_TERM_FOLLOW_UP_HORIZON_MS = 7 * DAY_MS;

export interface IntentionFollowUpSchedulerConfig {
  /**
   * Upper bound for the active intention queue. Later work is represented by
   * the durable scheduled-prompt/calendar lane instead of occupying a pending
   * follow-up slot.
   */
  nearTermHorizonMs: number;
}

export function validateIntentionFollowUpSchedulerConfig(
  raw: unknown,
  sourcePath: string,
): IntentionFollowUpSchedulerConfig {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: intentionFollowUp must be an object`,
    );
  }
  assertNoUnknownKeys(raw, ['nearTermHorizonMs'], 'intentionFollowUp');
  const nearTermHorizonMs = toInterval(
    raw.nearTermHorizonMs,
    'intentionFollowUp.nearTermHorizonMs',
  );
  if (nearTermHorizonMs > MAX_NEAR_TERM_FOLLOW_UP_HORIZON_MS) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: intentionFollowUp.nearTermHorizonMs `
      + `must be at most ${MAX_NEAR_TERM_FOLLOW_UP_HORIZON_MS}`,
    );
  }
  return { nearTermHorizonMs };
}
