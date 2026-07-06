import type { MemoryFormationVAD } from '../types.js';
import { clampUnit } from '../../../shared/utils/numeric.js';
import { DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT } from './types.js';

export { DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT };

export interface EmotionalImportanceAdjustmentInput {
  baseImportance: number;
  formationVAD?: MemoryFormationVAD;
  intensityWeight: number;
}

export function computeEmotionalIntensity(formationVAD?: MemoryFormationVAD): number {
  if (!formationVAD) return 0;

  const arousal = signedToUnit(formationVAD.arousal);
  const valence = signedToUnit(formationVAD.valence);
  const valenceExtremity = Math.abs(valence - 0.5) * 2;
  return clampUnit((arousal + valenceExtremity) / 2);
}

export function applyEmotionalIntensityImportanceMultiplier(
  input: EmotionalImportanceAdjustmentInput,
): number {
  const baseImportance = clampUnit(input.baseImportance);
  const intensityWeight = clampUnit(input.intensityWeight);
  if (intensityWeight <= 0) return baseImportance;

  const intensity = computeEmotionalIntensity(input.formationVAD);
  if (intensity <= 0) return baseImportance;

  const multiplier = 1 + (intensityWeight * intensity);
  return clampUnit(baseImportance * multiplier);
}

function signedToUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return clampUnit((value + 1) / 2);
}
