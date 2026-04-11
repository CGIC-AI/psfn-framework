import type { TrustLevel } from '../../system/trust/types.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';
import { wrapPromptSectionXml } from '../identity/prompt-sections.js';

export interface EmotionalExpressionDisplayRange {
  min: number;
  max: number;
}

export interface EmotionalExpressionProfile {
  intensity: number;
  variability: number;
  control: number;
  displayRange: EmotionalExpressionDisplayRange;
}

type EmotionalExpressionProfileInput = Omit<Partial<EmotionalExpressionProfile>, 'displayRange'> & {
  displayRange?: Partial<EmotionalExpressionDisplayRange>;
};

export interface PersonaAffectBehavior {
  mode: 'honne' | 'tatemae';
  warmth: number;
  formality: number;
  energy: number;
  assertiveness: number;
  expressiveness: number;
  profile: EmotionalExpressionProfile;
}

export interface EmotionalExpressionSourceInput {
  promptVariables?: Record<string, string>;
  config?: unknown;
}

export interface PersonaAffectInput {
  trustLevel: TrustLevel;
  emotionSnapshot: EmotionStateSnapshot;
  profile?: EmotionalExpressionProfileInput;
}

export interface EmotionalAffectSectionInput extends EmotionalExpressionSourceInput {
  trustLevel: TrustLevel;
  emotionSnapshot?: EmotionStateSnapshot | null;
}

interface TrustGate {
  mode: 'honne' | 'tatemae';
  expressivityCeiling: number;
  controlFloor: number;
}

const DEFAULT_PROFILE: EmotionalExpressionProfile = {
  intensity: 0.5,
  variability: 0.5,
  control: 0.6,
  displayRange: {
    min: 0,
    max: 0.8,
  },
};

const DEFAULT_TRUST_GATE: TrustGate = {
  mode: 'tatemae',
  expressivityCeiling: 0.5,
  controlFloor: 0.75,
};

const EPSILON = 1e-6;

const PROMPT_VARIABLE_KEYS = {
  intensity: [
    'hexaco_emotional_expression_intensity',
    'extensions_hexaco_emotional_expression_intensity',
    'character.hexaco.emotional_expression.intensity',
    'emotional_expression_intensity',
  ],
  variability: [
    'hexaco_emotional_expression_variability',
    'extensions_hexaco_emotional_expression_variability',
    'character.hexaco.emotional_expression.variability',
    'emotional_expression_variability',
  ],
  control: [
    'hexaco_emotional_expression_control',
    'extensions_hexaco_emotional_expression_control',
    'character.hexaco.emotional_expression.control',
    'emotional_expression_control',
  ],
  displayRangeMin: [
    'hexaco_emotional_expression_display_range_min',
    'extensions_hexaco_emotional_expression_display_range_min',
    'character.hexaco.emotional_expression.display_range.min',
    'emotional_expression_display_range_min',
  ],
  displayRangeMax: [
    'hexaco_emotional_expression_display_range_max',
    'extensions_hexaco_emotional_expression_display_range_max',
    'character.hexaco.emotional_expression.display_range.max',
    'emotional_expression_display_range_max',
  ],
} as const;

const CONFIG_PATHS = {
  intensity: [
    ['emotionAffect', 'emotionalExpression', 'intensity'],
    ['emotionAffect', 'emotional_expression', 'intensity'],
    ['emotionAffect', 'intensity'],
    ['emotion', 'emotionalExpression', 'intensity'],
    ['emotion', 'emotional_expression', 'intensity'],
    ['hexaco', 'emotionalExpression', 'intensity'],
    ['hexaco', 'emotional_expression', 'intensity'],
    ['emotionalExpressionIntensity'],
    ['hexacoEmotionalExpressionIntensity'],
  ],
  variability: [
    ['emotionAffect', 'emotionalExpression', 'variability'],
    ['emotionAffect', 'emotional_expression', 'variability'],
    ['emotionAffect', 'variability'],
    ['emotion', 'emotionalExpression', 'variability'],
    ['emotion', 'emotional_expression', 'variability'],
    ['hexaco', 'emotionalExpression', 'variability'],
    ['hexaco', 'emotional_expression', 'variability'],
    ['emotionalExpressionVariability'],
    ['hexacoEmotionalExpressionVariability'],
  ],
  control: [
    ['emotionAffect', 'emotionalExpression', 'control'],
    ['emotionAffect', 'emotional_expression', 'control'],
    ['emotionAffect', 'control'],
    ['emotion', 'emotionalExpression', 'control'],
    ['emotion', 'emotional_expression', 'control'],
    ['hexaco', 'emotionalExpression', 'control'],
    ['hexaco', 'emotional_expression', 'control'],
    ['emotionalExpressionControl'],
    ['hexacoEmotionalExpressionControl'],
  ],
  displayRangeMin: [
    ['emotionAffect', 'emotionalExpression', 'displayRange', 'min'],
    ['emotionAffect', 'emotionalExpression', 'display_range', 'min'],
    ['emotionAffect', 'displayRange', 'min'],
    ['emotionAffect', 'display_range', 'min'],
    ['emotionAffect', 'displayRangeMin'],
    ['emotionAffect', 'display_range_min'],
    ['emotion', 'emotionalExpression', 'displayRange', 'min'],
    ['emotion', 'emotional_expression', 'display_range', 'min'],
    ['hexaco', 'emotionalExpression', 'displayRange', 'min'],
    ['hexaco', 'emotional_expression', 'display_range', 'min'],
    ['emotionalExpressionDisplayRangeMin'],
    ['hexacoEmotionalExpressionDisplayRangeMin'],
  ],
  displayRangeMax: [
    ['emotionAffect', 'emotionalExpression', 'displayRange', 'max'],
    ['emotionAffect', 'emotionalExpression', 'display_range', 'max'],
    ['emotionAffect', 'displayRange', 'max'],
    ['emotionAffect', 'display_range', 'max'],
    ['emotionAffect', 'displayRangeMax'],
    ['emotionAffect', 'display_range_max'],
    ['emotion', 'emotionalExpression', 'displayRange', 'max'],
    ['emotion', 'emotional_expression', 'display_range', 'max'],
    ['hexaco', 'emotionalExpression', 'displayRange', 'max'],
    ['hexaco', 'emotional_expression', 'display_range', 'max'],
    ['emotionalExpressionDisplayRangeMax'],
    ['hexacoEmotionalExpressionDisplayRangeMax'],
  ],
} as const;

export function resolveEmotionalExpressionProfile(
  input: EmotionalExpressionSourceInput = {},
): EmotionalExpressionProfile {
  const promptProfile = parseProfileFromPromptVariables(input.promptVariables);
  const configProfile = parseProfileFromConfig(input.config);

  return normalizeProfile({
    ...promptProfile,
    ...configProfile,
    displayRange: {
      ...(promptProfile.displayRange ?? {}),
      ...(configProfile.displayRange ?? {}),
    },
  });
}

export function mapEmotionToPersonaAffect(input: PersonaAffectInput): PersonaAffectBehavior {
  const trustGate = resolveTrustGate(input.trustLevel);
  const profile = normalizeProfile(input.profile);
  const confidence = clampUnit(input.emotionSnapshot.confidence);
  const confidenceScale = 0.35 + (confidence * 0.65);

  const blendedVad = blendVad(
    input.emotionSnapshot.mood,
    input.emotionSnapshot.vad,
    profile.variability,
  );
  const intensityScale = lerp(0.55, 1.45, profile.intensity);
  const intensityVad = scaleVad(blendedVad, intensityScale);
  const effectiveControl = Math.max(profile.control, trustGate.controlFloor);
  const controlScale = 1 - (effectiveControl * 0.7);
  const controlledVad = scaleVad(intensityVad, controlScale);
  const trustScaledVad = scaleVad(controlledVad, trustGate.expressivityCeiling * confidenceScale);
  const boundedVad = applyDisplayRange(trustScaledVad, profile.displayRange);

  const warmth = clampSigned(boundedVad.valence);
  const energy = clampSigned(boundedVad.arousal);
  const assertiveness = clampSigned(boundedVad.dominance);
  const formality = clampSigned((-0.65 * warmth) + (-0.25 * energy) + (-0.1 * assertiveness));
  const discretePeak = resolveDiscretePeak(input.emotionSnapshot.discrete);
  const vadIntensity = averageAbsoluteVad(boundedVad);
  const rawExpressiveness = clampUnit((vadIntensity * 0.7) + (discretePeak * 0.3));
  const rangedExpressiveness = clampUnitToDisplayRange(rawExpressiveness, profile.displayRange);
  const expressiveness = clampUnit(rangedExpressiveness * (1 - (effectiveControl * 0.5)));

  return {
    mode: trustGate.mode,
    warmth,
    formality,
    energy,
    assertiveness,
    expressiveness,
    profile,
  };
}

export function buildEmotionalAffectSection(input: EmotionalAffectSectionInput): string | null {
  if (!input.emotionSnapshot) return null;

  const affect = mapEmotionToPersonaAffect({
    trustLevel: input.trustLevel,
    emotionSnapshot: input.emotionSnapshot,
    profile: resolveEmotionalExpressionProfile({
      promptVariables: input.promptVariables,
      config: input.config,
    }),
  });

  const lines = [
    `Trust gate: ${affect.mode === 'honne' ? 'honne (genuine)' : 'tatemae (controlled)'}`,
    `Affect modifiers: warmth=${formatSigned(affect.warmth)},`
      + ` formality=${formatSigned(affect.formality)},`
      + ` energy=${formatSigned(affect.energy)},`
      + ` assertiveness=${formatSigned(affect.assertiveness)},`
      + ` expressiveness=${affect.expressiveness.toFixed(3)}`,
    `Expression controls: intensity=${affect.profile.intensity.toFixed(3)},`
      + ` variability=${affect.profile.variability.toFixed(3)},`
      + ` control=${affect.profile.control.toFixed(3)},`
      + ` display_range=${affect.profile.displayRange.min.toFixed(3)}..${affect.profile.displayRange.max.toFixed(3)}`,
    `Guidance: ${describeGuidance(affect)}`,
  ];

  return wrapPromptSectionXml({
    id: 'emotional_affect',
    content: lines.join('\n'),
  });
}

function parseProfileFromPromptVariables(
  promptVariables: Record<string, string> | undefined,
): EmotionalExpressionProfileInput {
  if (!promptVariables) return {};

  const intensity = readNumberFromRecord(promptVariables, PROMPT_VARIABLE_KEYS.intensity);
  const variability = readNumberFromRecord(promptVariables, PROMPT_VARIABLE_KEYS.variability);
  const control = readNumberFromRecord(promptVariables, PROMPT_VARIABLE_KEYS.control);
  const displayRangeMin = readNumberFromRecord(promptVariables, PROMPT_VARIABLE_KEYS.displayRangeMin);
  const displayRangeMax = readNumberFromRecord(promptVariables, PROMPT_VARIABLE_KEYS.displayRangeMax);

  return {
    ...(intensity !== undefined ? { intensity } : {}),
    ...(variability !== undefined ? { variability } : {}),
    ...(control !== undefined ? { control } : {}),
    ...(
      displayRangeMin !== undefined || displayRangeMax !== undefined
        ? {
          displayRange: {
            ...(displayRangeMin !== undefined ? { min: displayRangeMin } : {}),
            ...(displayRangeMax !== undefined ? { max: displayRangeMax } : {}),
          },
        }
        : {}
    ),
  };
}

function parseProfileFromConfig(config: unknown): EmotionalExpressionProfileInput {
  const intensity = readNumberByPaths(config, CONFIG_PATHS.intensity);
  const variability = readNumberByPaths(config, CONFIG_PATHS.variability);
  const control = readNumberByPaths(config, CONFIG_PATHS.control);
  const displayRangeMin = readNumberByPaths(config, CONFIG_PATHS.displayRangeMin);
  const displayRangeMax = readNumberByPaths(config, CONFIG_PATHS.displayRangeMax);

  return {
    ...(intensity !== undefined ? { intensity } : {}),
    ...(variability !== undefined ? { variability } : {}),
    ...(control !== undefined ? { control } : {}),
    ...(
      displayRangeMin !== undefined || displayRangeMax !== undefined
        ? {
          displayRange: {
            ...(displayRangeMin !== undefined ? { min: displayRangeMin } : {}),
            ...(displayRangeMax !== undefined ? { max: displayRangeMax } : {}),
          },
        }
        : {}
    ),
  };
}

function resolveTrustGate(trustLevel: TrustLevel): TrustGate {
  switch (trustLevel) {
    case 'primary':
      return {
        mode: 'honne',
        expressivityCeiling: 1,
        controlFloor: 0,
      };
    case 'trusted':
      return {
        mode: 'tatemae',
        expressivityCeiling: 0.82,
        controlFloor: 0.35,
      };
    case 'regular':
      return {
        mode: 'tatemae',
        expressivityCeiling: 0.66,
        controlFloor: 0.55,
      };
    case 'public':
      return DEFAULT_TRUST_GATE;
    default:
      return DEFAULT_TRUST_GATE;
  }
}

function describeGuidance(affect: PersonaAffectBehavior): string {
  const warmth = describeSignedScale(affect.warmth, 'warmer', 'cooler');
  const formality = describeSignedScale(affect.formality, 'more formal', 'more relaxed');
  const energy = describeSignedScale(affect.energy, 'higher energy', 'calmer energy');
  const assertiveness = describeSignedScale(affect.assertiveness, 'more assertive', 'more deferential');
  const expressiveness = describeExpressiveness(affect.expressiveness);
  const privacyConstraint = affect.mode === 'honne'
    ? 'You may show genuine internal affect.'
    : 'Keep emotional expression surface-level and privacy-safe.';
  return `${warmth}, ${formality}, ${energy}, ${assertiveness}, with ${expressiveness} emotional display. ${privacyConstraint}`;
}

function describeSignedScale(value: number, positive: string, negative: string): string {
  if (value >= 0.45) return positive;
  if (value >= 0.15) return `slightly ${positive}`;
  if (value <= -0.45) return negative;
  if (value <= -0.15) return `slightly ${negative}`;
  return 'balanced tone';
}

function describeExpressiveness(value: number): string {
  if (value >= 0.75) return 'strong';
  if (value >= 0.45) return 'moderate';
  if (value >= 0.2) return 'light';
  return 'minimal';
}

function normalizeProfile(
  profile: EmotionalExpressionProfileInput | undefined,
): EmotionalExpressionProfile {
  const min = clampUnit(profile?.displayRange?.min ?? DEFAULT_PROFILE.displayRange.min);
  const max = clampUnit(profile?.displayRange?.max ?? DEFAULT_PROFILE.displayRange.max);
  const displayRange = {
    min: Math.min(min, max),
    max: Math.max(min, max),
  };

  return {
    intensity: clampUnit(profile?.intensity ?? DEFAULT_PROFILE.intensity),
    variability: clampUnit(profile?.variability ?? DEFAULT_PROFILE.variability),
    control: clampUnit(profile?.control ?? DEFAULT_PROFILE.control),
    displayRange,
  };
}

function applyDisplayRange(vad: VADVector, range: EmotionalExpressionDisplayRange): VADVector {
  return {
    valence: clampSignedToRange(vad.valence, range),
    arousal: clampSignedToRange(vad.arousal, range),
    dominance: clampSignedToRange(vad.dominance, range),
  };
}

function clampSignedToRange(value: number, range: EmotionalExpressionDisplayRange): number {
  const clamped = clampSigned(value);
  const absolute = Math.abs(clamped);
  if (absolute <= EPSILON) return 0;
  const bounded = clamp(absolute, range.min, range.max);
  return Math.sign(clamped) * bounded;
}

function clampUnitToDisplayRange(value: number, range: EmotionalExpressionDisplayRange): number {
  const clamped = clampUnit(value);
  if (clamped <= EPSILON) return 0;
  return clamp(clamped, range.min, range.max);
}

function resolveDiscretePeak(discrete: Record<string, number>): number {
  let max = 0;
  for (const value of Object.values(discrete)) {
    if (!Number.isFinite(value)) continue;
    max = Math.max(max, clampUnit(value));
  }
  return max;
}

function averageAbsoluteVad(vad: VADVector): number {
  return (Math.abs(vad.valence) + Math.abs(vad.arousal) + Math.abs(vad.dominance)) / 3;
}

function blendVad(mood: VADVector, current: VADVector, variability: number): VADVector {
  const alpha = clampUnit(variability);
  return {
    valence: clampSigned(mood.valence + ((current.valence - mood.valence) * alpha)),
    arousal: clampSigned(mood.arousal + ((current.arousal - mood.arousal) * alpha)),
    dominance: clampSigned(mood.dominance + ((current.dominance - mood.dominance) * alpha)),
  };
}

function scaleVad(vad: VADVector, multiplier: number): VADVector {
  return {
    valence: clampSigned(vad.valence * multiplier),
    arousal: clampSigned(vad.arousal * multiplier),
    dominance: clampSigned(vad.dominance * multiplier),
  };
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function readNumberFromRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = toFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumberByPaths(
  source: unknown,
  paths: ReadonlyArray<readonly string[]>,
): number | undefined {
  for (const path of paths) {
    const value = getPathValue(source, path);
    const numeric = toFiniteNumber(value);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

function getPathValue(source: unknown, path: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of path) {
    const record = asRecord(cursor);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
      return undefined;
    }
    cursor = record[segment];
  }
  return cursor;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function lerp(min: number, max: number, t: number): number {
  return min + ((max - min) * clampUnit(t));
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
