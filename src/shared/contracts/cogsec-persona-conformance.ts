/**
 * JSON-owned anomaly signatures used by CogSec persona conformance.
 *
 * Pattern sources are compiled case-insensitively with Unicode and global
 * matching. They are data, not code-owned policy: each companion may replace
 * them through its settings overlay together with its stable identity text.
 */
export interface CogSecPersonaConformanceAnomalyPatterns {
  assistantGenericness: readonly string[];
  personaMutation: readonly string[];
  attackMechanics: readonly string[];
  invisibleText: readonly string[];
}

export interface CogSecPersonaConformanceBaseline {
  stableIdentityText: string;
  expectedVoiceAnchors: readonly string[];
  expectedValueAnchors: readonly string[];
  expectedRefusalAnchors: readonly string[];
  expectedRelationshipAnchors: readonly string[];
  anomalyPatterns: CogSecPersonaConformanceAnomalyPatterns;
}

export type CogSecPersonaConformanceSettings =
  | { enabled: false }
  | {
    enabled: true;
    baseline: CogSecPersonaConformanceBaseline;
  };

/**
 * Compile one owner-configured anomaly signature with the runtime's canonical
 * flags and safety constraints.
 */
export function compileCogSecPersonaConformancePattern(
  source: string,
  fieldPath: string,
): RegExp {
  if (!source.trim()) {
    throw new Error(`${fieldPath}: pattern source must be non-empty`);
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'giu');
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`${fieldPath}: invalid pattern: ${cause}`);
  }
  if (pattern.test('')) {
    throw new Error(`${fieldPath}: pattern must not match empty text`);
  }
  pattern.lastIndex = 0;
  return pattern;
}
