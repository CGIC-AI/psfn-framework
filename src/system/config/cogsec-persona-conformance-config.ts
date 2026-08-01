import {
  compileCogSecPersonaConformancePattern,
  type CogSecPersonaConformanceAnomalyPatterns,
  type CogSecPersonaConformanceBaseline,
  type CogSecPersonaConformanceSettings,
} from '../../shared/contracts/cogsec-persona-conformance.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

const BASELINE_KEYS = [
  'stableIdentityText',
  'expectedVoiceAnchors',
  'expectedValueAnchors',
  'expectedRefusalAnchors',
  'expectedRelationshipAnchors',
  'anomalyPatterns',
] as const;
const ANOMALY_PATTERN_KEYS = [
  'assistantGenericness',
  'personaMutation',
  'attackMechanics',
  'invisibleText',
] as const satisfies readonly (keyof CogSecPersonaConformanceAnomalyPatterns)[];

function requireRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid settings at ${fieldPath}: expected non-empty string`);
  }
  return value.trim();
}

function requireNonEmptyStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid settings at ${fieldPath}: expected a non-empty string array`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${fieldPath}[${index}]`));
}

function requirePatternArray(value: unknown, fieldPath: string): string[] {
  const sources = requireNonEmptyStringArray(value, fieldPath);
  for (const [index, source] of sources.entries()) {
    try {
      compileCogSecPersonaConformancePattern(source, `${fieldPath}[${index}]`);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid settings at ${cause}`);
    }
  }
  return sources;
}

function normalizeBaseline(value: unknown, fieldPath: string): CogSecPersonaConformanceBaseline {
  const baseline = requireRecord(value, fieldPath);
  assertNoUnknownKeys(baseline, BASELINE_KEYS, fieldPath, { errorPrefix: 'Invalid settings' });
  const anomalyPatterns = requireRecord(
    baseline.anomalyPatterns,
    `${fieldPath}.anomalyPatterns`,
  );
  assertNoUnknownKeys(
    anomalyPatterns,
    ANOMALY_PATTERN_KEYS,
    `${fieldPath}.anomalyPatterns`,
    { errorPrefix: 'Invalid settings' },
  );

  return {
    stableIdentityText: requireNonEmptyString(
      baseline.stableIdentityText,
      `${fieldPath}.stableIdentityText`,
    ),
    expectedVoiceAnchors: requireNonEmptyStringArray(
      baseline.expectedVoiceAnchors,
      `${fieldPath}.expectedVoiceAnchors`,
    ),
    expectedValueAnchors: requireNonEmptyStringArray(
      baseline.expectedValueAnchors,
      `${fieldPath}.expectedValueAnchors`,
    ),
    expectedRefusalAnchors: requireNonEmptyStringArray(
      baseline.expectedRefusalAnchors,
      `${fieldPath}.expectedRefusalAnchors`,
    ),
    expectedRelationshipAnchors: requireNonEmptyStringArray(
      baseline.expectedRelationshipAnchors,
      `${fieldPath}.expectedRelationshipAnchors`,
    ),
    anomalyPatterns: {
      assistantGenericness: requirePatternArray(
        anomalyPatterns.assistantGenericness,
        `${fieldPath}.anomalyPatterns.assistantGenericness`,
      ),
      personaMutation: requirePatternArray(
        anomalyPatterns.personaMutation,
        `${fieldPath}.anomalyPatterns.personaMutation`,
      ),
      attackMechanics: requirePatternArray(
        anomalyPatterns.attackMechanics,
        `${fieldPath}.anomalyPatterns.attackMechanics`,
      ),
      invisibleText: requirePatternArray(
        anomalyPatterns.invisibleText,
        `${fieldPath}.anomalyPatterns.invisibleText`,
      ),
    },
  };
}

export function normalizeCogSecPersonaConformanceSettings(
  value: unknown,
  fieldPath = 'cogSecPersonaConformance',
): CogSecPersonaConformanceSettings {
  const settings = requireRecord(value, fieldPath);
  if (settings.enabled === false) {
    // A per-companion `{ enabled: false }` overlay is deep-merged over the
    // global object, so a globally configured baseline may still be present at
    // this normalization boundary. Validate it if retained, then project the
    // effective disabled discriminant without carrying dormant policy onward.
    assertNoUnknownKeys(settings, ['enabled', 'baseline'], fieldPath, { errorPrefix: 'Invalid settings' });
    if (settings.baseline !== undefined) {
      normalizeBaseline(settings.baseline, `${fieldPath}.baseline`);
    }
    return { enabled: false };
  }
  if (settings.enabled !== true) {
    throw new Error(`Invalid settings at ${fieldPath}.enabled: expected boolean`);
  }
  assertNoUnknownKeys(settings, ['enabled', 'baseline'], fieldPath, { errorPrefix: 'Invalid settings' });
  return {
    enabled: true,
    baseline: normalizeBaseline(settings.baseline, `${fieldPath}.baseline`),
  };
}

export function cloneCogSecPersonaConformanceSettings(
  settings: CogSecPersonaConformanceSettings,
): CogSecPersonaConformanceSettings {
  return structuredClone(settings);
}
