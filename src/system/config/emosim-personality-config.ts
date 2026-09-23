import type { EmoSimPersonalitySettings } from '../../shared/contracts/runtime.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

const EMOSIM_PERSONALITY_TRAITS = ['O', 'C', 'E', 'A', 'N'] as const;

/**
 * Validate one companion's emo_sim Big Five. Every trait is required and must
 * be a finite number in 0..1; unknown keys reject. There is deliberately no
 * default temperament: a missing or partial personality fails closed instead
 * of silently giving every companion the same shared subject.
 */
export function normalizeEmoSimPersonality(
  value: unknown,
  fieldPath: string,
  errorPrefix: string,
): EmoSimPersonalitySettings {
  if (!isRecord(value)) {
    throw new Error(`${errorPrefix} at ${fieldPath}: must be an object with O, C, E, A, N traits`);
  }
  assertNoUnknownKeys(value, EMOSIM_PERSONALITY_TRAITS, fieldPath, { errorPrefix });
  const trait = (key: typeof EMOSIM_PERSONALITY_TRAITS[number]): number => {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new Error(`${errorPrefix} at ${fieldPath}.${key}: must be a finite number within 0..1`);
    }
    return raw;
  };
  return { O: trait('O'), C: trait('C'), E: trait('E'), A: trait('A'), N: trait('N') };
}
