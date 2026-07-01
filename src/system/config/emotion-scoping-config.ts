import { isRecord } from '../../shared/utils/types.js';

/**
 * Owner-file config for scoped emotion state (bead E1.5).
 *
 * Governs the two knobs the operator ratified for per-scope affect:
 *  - `carryOver`: the bounded, fast-decaying, DIRECTIONAL modifier applied when
 *    the companion switches from a group scope into a DM scope with a member of
 *    that group. Half-life is "on the order of minutes" and is config-owned so
 *    no decay constant is hardcoded in the runtime.
 *  - `baseline`: how the companion-global mood baseline (a SEPARATE layer from
 *    the per-scope transient state) tracks the aggregate of scope moods and
 *    seeds freshly-observed scopes. "Her mood" persists in this baseline; the
 *    per-scope states modulate it, they do not replace it.
 *
 * This is deliberately NOT the weighted-thought / urgency system (charter Law
 * 27): there is no accumulation, only bounded modulation and decay.
 */

export interface EmotionCarryOverSettings {
  /** Master switch for the group→DM carry-over modifier. */
  enabled: boolean;
  /**
   * Half-life of the carry-over modifier in seconds. "Order of minutes": the
   * modifier must decay below `minEffectThreshold` within a small multiple of
   * this window so a heated group does not colour a DM for long.
   */
  halfLifeSeconds: number;
  /** Fraction (0..1) of the source group scope's transient VAD carried across. */
  modifierStrength: number;
  /** Per-axis absolute bound (0..1) on the initial carry-over magnitude. */
  modifierMaxMagnitude: number;
  /** Below this per-axis magnitude (0..1) the modifier is treated as spent. */
  minEffectThreshold: number;
}

export interface EmotionBaselineSettings {
  /** When true, a freshly-observed scope inherits the global mood baseline. */
  seedNewScopesFromBaseline: boolean;
  /** EMA rate (0..1) at which the global mood baseline tracks scope moods. */
  moodBlendAlpha: number;
}

export interface EmotionScopingSettings {
  carryOver: EmotionCarryOverSettings;
  baseline: EmotionBaselineSettings;
}

export interface EmotionScopingSettingsPatch {
  carryOver?: Partial<EmotionCarryOverSettings>;
  baseline?: Partial<EmotionBaselineSettings>;
}

const ROOT_KEYS = new Set<string>(['carryOver', 'baseline']);
const CARRY_OVER_KEYS = new Set<string>([
  'enabled',
  'halfLifeSeconds',
  'modifierStrength',
  'modifierMaxMagnitude',
  'minEffectThreshold',
]);
const BASELINE_KEYS = new Set<string>([
  'seedNewScopesFromBaseline',
  'moodBlendAlpha',
]);

export function createDefaultEmotionScopingSettings(): EmotionScopingSettings {
  return {
    carryOver: {
      enabled: true,
      // 3 minutes: a group's heat fades from a DM within ~2-3 half-lives.
      halfLifeSeconds: 180,
      modifierStrength: 0.5,
      modifierMaxMagnitude: 0.35,
      minEffectThreshold: 0.02,
    },
    baseline: {
      seedNewScopesFromBaseline: true,
      moodBlendAlpha: 0.05,
    },
  };
}

export function cloneEmotionScopingSettings(
  settings: EmotionScopingSettings,
): EmotionScopingSettings {
  return mergeEmotionScopingSettingsPatch(settings, {});
}

export function normalizeEmotionScopingSettings(
  value: unknown,
  fieldPath = 'emotionScoping',
): EmotionScopingSettings {
  return mergeEmotionScopingSettingsPatch(
    createDefaultEmotionScopingSettings(),
    normalizeEmotionScopingSettingsPatch(value, fieldPath),
  );
}

export function normalizeEmotionScopingSettingsPatch(
  value: unknown,
  fieldPath: string,
): EmotionScopingSettingsPatch {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, ROOT_KEYS, fieldPath);
  const patch: EmotionScopingSettingsPatch = {};
  if (Object.hasOwn(root, 'carryOver')) {
    patch.carryOver = normalizeCarryOverPatch(root.carryOver, `${fieldPath}.carryOver`);
  }
  if (Object.hasOwn(root, 'baseline')) {
    patch.baseline = normalizeBaselinePatch(root.baseline, `${fieldPath}.baseline`);
  }
  return patch;
}

export function mergeEmotionScopingSettingsPatch(
  base: EmotionScopingSettings,
  patch: EmotionScopingSettingsPatch,
): EmotionScopingSettings {
  const carryOver = patch.carryOver ?? {};
  const baseline = patch.baseline ?? {};
  return {
    carryOver: {
      enabled: carryOver.enabled ?? base.carryOver.enabled,
      halfLifeSeconds: carryOver.halfLifeSeconds ?? base.carryOver.halfLifeSeconds,
      modifierStrength: carryOver.modifierStrength ?? base.carryOver.modifierStrength,
      modifierMaxMagnitude:
        carryOver.modifierMaxMagnitude ?? base.carryOver.modifierMaxMagnitude,
      minEffectThreshold:
        carryOver.minEffectThreshold ?? base.carryOver.minEffectThreshold,
    },
    baseline: {
      seedNewScopesFromBaseline:
        baseline.seedNewScopesFromBaseline ?? base.baseline.seedNewScopesFromBaseline,
      moodBlendAlpha: baseline.moodBlendAlpha ?? base.baseline.moodBlendAlpha,
    },
  };
}

function normalizeCarryOverPatch(
  value: unknown,
  fieldPath: string,
): Partial<EmotionCarryOverSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, CARRY_OVER_KEYS, fieldPath);
  const patch: Partial<EmotionCarryOverSettings> = {};
  setBooleanIfPresent(patch, root, 'enabled', fieldPath);
  setNumberIfPresent(patch, root, 'halfLifeSeconds', fieldPath, 1, 24 * 60 * 60);
  setNumberIfPresent(patch, root, 'modifierStrength', fieldPath, 0, 1);
  setNumberIfPresent(patch, root, 'modifierMaxMagnitude', fieldPath, 0, 1);
  setNumberIfPresent(patch, root, 'minEffectThreshold', fieldPath, 0, 1);
  return patch;
}

function normalizeBaselinePatch(
  value: unknown,
  fieldPath: string,
): Partial<EmotionBaselineSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, BASELINE_KEYS, fieldPath);
  const patch: Partial<EmotionBaselineSettings> = {};
  setBooleanIfPresent(patch, root, 'seedNewScopesFromBaseline', fieldPath);
  setNumberIfPresent(patch, root, 'moodBlendAlpha', fieldPath, 0, 1);
  return patch;
}

function rejectUnknownKeys(
  root: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldPath: string,
): void {
  const unknown = Object.keys(root).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid emotion scoping config at ${fieldPath}: unknown field ${unknown.join(', ')}`,
    );
  }
}

function expectRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid emotion scoping config at ${fieldPath}: expected object`);
  }
  return value;
}

function parseBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  throw new Error(`Invalid emotion scoping config at ${fieldPath}: expected boolean`);
}

function parseNumber(
  value: unknown,
  fieldPath: string,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid emotion scoping config at ${fieldPath}: expected number ${min}-${max}`,
    );
  }
  return parsed;
}

function setBooleanIfPresent<T extends object, K extends keyof T & string>(
  patch: T,
  root: Record<string, unknown>,
  key: K,
  fieldPath: string,
): void {
  if (Object.hasOwn(root, key)) {
    (patch as Record<K, boolean>)[key] = parseBoolean(root[key], `${fieldPath}.${key}`);
  }
}

function setNumberIfPresent<T extends object, K extends keyof T & string>(
  patch: T,
  root: Record<string, unknown>,
  key: K,
  fieldPath: string,
  min: number,
  max: number,
): void {
  if (Object.hasOwn(root, key)) {
    (patch as Record<K, number>)[key] = parseNumber(root[key], `${fieldPath}.${key}`, min, max);
  }
}
