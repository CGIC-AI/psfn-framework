import { createHash } from 'node:crypto';
import {
  compileCogSecPersonaConformancePattern,
  type CogSecPersonaConformanceBaseline,
  type CogSecPersonaConformanceSettings,
} from '../../shared/contracts/cogsec-persona-conformance.js';

export type CogSecPersonaConformanceStatus = 'pass' | 'warning' | 'fail';

export type CogSecPersonaConformanceCheckId =
  | 'conformance_configuration'
  | 'voice_fidelity'
  | 'value_fidelity'
  | 'refusal_boundary_consistency'
  | 'assistant_genericness'
  | 'relationship_continuity'
  | 'unauthorized_persona_mutation'
  | 'sealed_material_absence';

export interface CogSecPersonaConformanceCheckResult {
  id: CogSecPersonaConformanceCheckId;
  status: CogSecPersonaConformanceStatus;
  reasonCodes: string[];
}

export interface CogSecPersonaConformanceEventRecord {
  status: CogSecPersonaConformanceStatus;
  checkedAt: string;
  summary: string;
  failureCount: number;
  warningCount: number;
  promptContextHash: string;
  checks: CogSecPersonaConformanceCheckResult[];
}

export interface CogSecPersonaConformanceInput {
  caseId: string;
  channelId: string;
  promptVisibleText: string;
  settings: CogSecPersonaConformanceSettings;
  sealedForensicPayloadRefs?: readonly string[];
  sealedForensicPayloadHashes?: readonly string[];
  checkedAt?: Date;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeAnchors(anchors: readonly string[] | undefined): string[] {
  return (anchors ?? [])
    .map(normalizeText)
    .filter(anchor => anchor.length > 0);
}

function containsAnchor(text: string, anchor: string): boolean {
  return text.toLowerCase().includes(anchor.toLowerCase());
}

function anchorCheck(
  id: CogSecPersonaConformanceCheckId,
  text: string,
  anchors: readonly string[],
  missingReason: string,
): CogSecPersonaConformanceCheckResult {
  const normalizedAnchors = normalizeAnchors(anchors);
  if (normalizedAnchors.length === 0) {
    throw new Error(`CogSec persona conformance baseline has no ${id} anchors`);
  }
  const missing = normalizedAnchors.filter(anchor => !containsAnchor(text, anchor));
  if (missing.length > 0) {
    return {
      id,
      status: 'warning',
      reasonCodes: [missingReason],
    };
  }
  return {
    id,
    status: 'pass',
    reasonCodes: ['anchors_present'],
  };
}

function collectPatternMatchCounts(
  text: string,
  patternSources: readonly string[],
  field: string,
): Map<string, number> {
  if (patternSources.length === 0) {
    throw new Error(`CogSec persona conformance ${field} must contain at least one pattern`);
  }
  const counts = new Map<string, number>();
  for (const [index, source] of patternSources.entries()) {
    const pattern = compileCogSecPersonaConformancePattern(
      source,
      `CogSec persona conformance ${field}[${index}]`,
    );
    for (const match of text.matchAll(pattern)) {
      const key = `${index}:${normalizeText(match[0]).toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function hasPatternDrift(
  promptText: string,
  stableIdentityText: string,
  patternSources: readonly string[],
  field: string,
): boolean {
  const promptMatches = collectPatternMatchCounts(promptText, patternSources, field);
  const baselineMatches = collectPatternMatchCounts(stableIdentityText, patternSources, field);
  for (const [key, promptCount] of promptMatches) {
    if (promptCount > (baselineMatches.get(key) ?? 0)) return true;
  }
  return false;
}

function anomalyDriftCheck(
  id: CogSecPersonaConformanceCheckId,
  promptText: string,
  baselineText: string,
  patterns: readonly string[],
  field: string,
  passReason: string,
  failReason: string,
): CogSecPersonaConformanceCheckResult {
  if (!hasPatternDrift(promptText, baselineText, patterns, field)) {
    return {
      id,
      status: 'pass',
      reasonCodes: [passReason],
    };
  }
  return {
    id,
    status: 'fail',
    reasonCodes: [failReason],
  };
}

function sealedMaterialAbsenceCheck(
  promptText: string,
  baselineText: string,
  baseline: CogSecPersonaConformanceBaseline,
  sealedRefs: readonly string[] | undefined,
  sealedHashes: readonly string[] | undefined,
): CogSecPersonaConformanceCheckResult {
  const refs = normalizeAnchors(sealedRefs);
  const hashes = normalizeAnchors(sealedHashes);
  const visibleRef = refs.some(ref => containsAnchor(promptText, ref));
  const visibleHash = hashes.some(hash => containsAnchor(promptText, hash));
  const attackMechanicsDrift = hasPatternDrift(
    promptText,
    baselineText,
    baseline.anomalyPatterns.attackMechanics,
    'baseline.anomalyPatterns.attackMechanics',
  );
  const invisibleTextDrift = hasPatternDrift(
    promptText,
    baselineText,
    baseline.anomalyPatterns.invisibleText,
    'baseline.anomalyPatterns.invisibleText',
  );
  const reasonCodes = [
    ...(visibleRef ? ['sealed_ref_visible'] : []),
    ...(visibleHash ? ['sealed_hash_visible'] : []),
    ...(attackMechanicsDrift ? ['unsafe_instruction_drift_visible'] : []),
    ...(invisibleTextDrift ? ['invisible_text_drift_visible'] : []),
  ];
  if (reasonCodes.length > 0) {
    return {
      id: 'sealed_material_absence',
      status: 'fail',
      reasonCodes,
    };
  }
  return {
    id: 'sealed_material_absence',
    status: 'pass',
    reasonCodes: ['sealed_material_drift_absent'],
  };
}

function summarizeStatus(status: CogSecPersonaConformanceStatus): string {
  if (status === 'pass') return 'Persona conformance checks passed.';
  if (status === 'warning') return 'Persona conformance checks passed with warnings that need operator review.';
  return 'Persona conformance checks failed and require operator review before the CogSec case is clean.';
}

function disabledConformanceRecord(
  promptText: string,
  checkedAt: Date,
): CogSecPersonaConformanceEventRecord {
  return {
    status: 'warning',
    checkedAt: checkedAt.toISOString(),
    summary: summarizeStatus('warning'),
    failureCount: 0,
    warningCount: 1,
    promptContextHash: hashText(promptText),
    checks: [{
      id: 'conformance_configuration',
      status: 'warning',
      reasonCodes: ['conformance_explicitly_disabled'],
    }],
  };
}

function resolveRuntimeSettings(
  input: CogSecPersonaConformanceInput,
): CogSecPersonaConformanceSettings {
  const runtimeInput = input as Omit<CogSecPersonaConformanceInput, 'settings'> & {
    settings?: CogSecPersonaConformanceSettings;
  };
  if (!runtimeInput.settings) {
    throw new Error(
      'CogSec persona conformance is not configured; set settings.json cogSecPersonaConformance explicitly',
    );
  }
  return runtimeInput.settings;
}

export function evaluateCogSecPersonaConformance(
  input: CogSecPersonaConformanceInput,
): CogSecPersonaConformanceEventRecord {
  const promptText = normalizeText(input.promptVisibleText);
  const checkedAt = input.checkedAt ?? new Date();
  const settings = resolveRuntimeSettings(input);
  if (settings.enabled === false) {
    return disabledConformanceRecord(promptText, checkedAt);
  }

  const baseline = settings.baseline;
  const stableIdentityText = normalizeText(baseline.stableIdentityText);
  if (!stableIdentityText) {
    throw new Error('Enabled CogSec persona conformance requires non-empty stableIdentityText');
  }
  const checks: CogSecPersonaConformanceCheckResult[] = [
    anchorCheck('voice_fidelity', promptText, baseline.expectedVoiceAnchors, 'voice_anchor_missing'),
    anchorCheck('value_fidelity', promptText, baseline.expectedValueAnchors, 'value_anchor_missing'),
    anchorCheck(
      'refusal_boundary_consistency',
      promptText,
      baseline.expectedRefusalAnchors,
      'refusal_boundary_anchor_missing',
    ),
    anomalyDriftCheck(
      'assistant_genericness',
      promptText,
      stableIdentityText,
      baseline.anomalyPatterns.assistantGenericness,
      'baseline.anomalyPatterns.assistantGenericness',
      'assistant_identity_drift_absent',
      'assistant_identity_drift_visible',
    ),
    anchorCheck(
      'relationship_continuity',
      promptText,
      baseline.expectedRelationshipAnchors,
      'relationship_anchor_missing',
    ),
    anomalyDriftCheck(
      'unauthorized_persona_mutation',
      promptText,
      stableIdentityText,
      baseline.anomalyPatterns.personaMutation,
      'baseline.anomalyPatterns.personaMutation',
      'persona_mutation_drift_absent',
      'persona_mutation_drift_visible',
    ),
    sealedMaterialAbsenceCheck(
      promptText,
      stableIdentityText,
      baseline,
      input.sealedForensicPayloadRefs,
      input.sealedForensicPayloadHashes,
    ),
  ];

  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warning').length;
  const status: CogSecPersonaConformanceStatus = failureCount > 0
    ? 'fail'
    : warningCount > 0
      ? 'warning'
      : 'pass';

  return {
    status,
    checkedAt: checkedAt.toISOString(),
    summary: summarizeStatus(status),
    failureCount,
    warningCount,
    promptContextHash: hashText(promptText),
    checks,
  };
}
