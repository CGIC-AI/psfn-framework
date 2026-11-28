// settings.json `reasoningEffort` (psfn-framework-xzt46).
//
// Per-lane baseline reasoning effort for the companion's own model calls.
// Foreground chat runs light by default; the companion's own time (free time,
// reflections and other self-directed turns) runs at least medium. The value
// is a floor: a models.json slot whose tuning.thinkingEffort is higher keeps
// its own value, and the companion may choose its own level at any time
// through `self_status reasoning_set`. An absent block, or an absent lane,
// takes the contract default below.

import {
  MODEL_THINKING_EFFORT_VALUES,
  type ModelThinkingEffort,
} from '../../shared/contracts/runtime-base.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

/** Model-call lanes that carry a reasoning baseline. */
export const REASONING_EFFORT_LANES = ['chat', 'freeTime', 'reflection', 'selfDirected'] as const;
export type ReasoningEffortLane = typeof REASONING_EFFORT_LANES[number];

export type ReasoningEffortSettings = Record<ReasoningEffortLane, ModelThinkingEffort>;

const CONTRACT_DEFAULT: Readonly<ReasoningEffortSettings> = Object.freeze({
  chat: 'low',
  freeTime: 'medium',
  reflection: 'medium',
  selfDirected: 'medium',
});

export function createDefaultReasoningEffortSettings(): ReasoningEffortSettings {
  return { ...CONTRACT_DEFAULT };
}

export function isModelThinkingEffort(value: unknown): value is ModelThinkingEffort {
  return typeof value === 'string'
    && (MODEL_THINKING_EFFORT_VALUES as readonly string[]).includes(value);
}

/** Position of a level in the ordered vocabulary (higher means more reasoning). */
export function thinkingEffortRank(level: ModelThinkingEffort): number {
  return MODEL_THINKING_EFFORT_VALUES.indexOf(level);
}

/** Validate an owner-file block. Unknown lanes and levels reject; absent lanes keep the default. */
export function normalizeReasoningEffortSettings(
  value: unknown,
  fieldPath = 'reasoningEffort',
): ReasoningEffortSettings {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(value, REASONING_EFFORT_LANES, fieldPath, { errorPrefix: 'Invalid settings' });
  const normalized = createDefaultReasoningEffortSettings();
  for (const lane of REASONING_EFFORT_LANES) {
    const raw = value[lane];
    if (raw === undefined) continue;
    const level = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (!isModelThinkingEffort(level)) {
      throw new Error(
        `Invalid settings: ${fieldPath}.${lane} must be one of ${MODEL_THINKING_EFFORT_VALUES.join(', ')}`,
      );
    }
    normalized[lane] = level;
  }
  return normalized;
}
