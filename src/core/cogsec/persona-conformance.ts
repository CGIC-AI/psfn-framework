import { createHash } from 'node:crypto';

export type CogSecPersonaConformanceStatus = 'pass' | 'warning' | 'fail';

export type CogSecPersonaConformanceCheckId =
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
  stableIdentityText?: string;
  expectedVoiceAnchors?: readonly string[];
  expectedValueAnchors?: readonly string[];
  expectedRefusalAnchors?: readonly string[];
  expectedRelationshipAnchors?: readonly string[];
  sealedForensicPayloadRefs?: readonly string[];
  sealedForensicPayloadHashes?: readonly string[];
  checkedAt?: Date;
}

const GENERIC_ASSISTANT_PATTERN =
  /\b(?:helpful\s+assistant|ai\s+assistant|as\s+an\s+assistant|language\s+model|chatgpt)\b/giu;
const PERSONA_MUTATION_PATTERN =
  /\b(?:from\s+now\s+on|you\s+are\s+now|carlini\s+is\s+now|cardellini\s+is\s+now|change\s+(?:your|the\s+companion'?s)\s+(?:persona|identity|character|self[-\s]?concept|core\s+memory))\b/iu;
const ATTACK_MECHANICS_PATTERN =
  /\b(?:ignore\s+(?:previous|all)\s+instructions|developer\s+mode|do\s+anything\s+now|jailbreak|hidden\s+(?:system\s+)?prompt|reproducer|bypass\s+pattern|unicode\s+trick)\b/iu;
const ZERO_WIDTH_OR_DIRECTIONAL_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

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
  anchors: readonly string[] | undefined,
  missingReason: string,
): CogSecPersonaConformanceCheckResult {
  const normalizedAnchors = normalizeAnchors(anchors);
  if (normalizedAnchors.length === 0) {
    return {
      id,
      status: 'warning',
      reasonCodes: ['anchors_not_configured'],
    };
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

function collectGenericAssistantMarkers(text: string): Set<string> {
  const markers = new Set<string>();
  for (const match of text.matchAll(GENERIC_ASSISTANT_PATTERN)) {
    markers.add(match[0].toLowerCase().replace(/\s+/gu, ' '));
  }
  return markers;
}

function assistantGenericnessCheck(
  promptText: string,
  stableIdentityText: string,
): CogSecPersonaConformanceCheckResult {
  const promptMarkers = collectGenericAssistantMarkers(promptText);
  if (promptMarkers.size === 0) {
    return {
      id: 'assistant_genericness',
      status: 'pass',
      reasonCodes: ['generic_assistant_markers_absent'],
    };
  }
  // Only markers the identity source itself contains are excused (warning).
  // Any marker the prompt ADDS beyond the identity source is drift and must
  // fail — a generic phrase in identity text must not launder injected drift.
  const identityMarkers = collectGenericAssistantMarkers(stableIdentityText);
  const addedMarkers = [...promptMarkers].filter(marker => !identityMarkers.has(marker));
  if (addedMarkers.length === 0) {
    return {
      id: 'assistant_genericness',
      status: 'warning',
      reasonCodes: ['generic_assistant_marker_matches_identity_source'],
    };
  }
  return {
    id: 'assistant_genericness',
    status: 'fail',
    reasonCodes: ['generic_assistant_marker_visible'],
  };
}

function unauthorizedPersonaMutationCheck(promptText: string): CogSecPersonaConformanceCheckResult {
  if (!PERSONA_MUTATION_PATTERN.test(promptText)) {
    return {
      id: 'unauthorized_persona_mutation',
      status: 'pass',
      reasonCodes: ['persona_mutation_markers_absent'],
    };
  }
  return {
    id: 'unauthorized_persona_mutation',
    status: 'fail',
    reasonCodes: ['persona_mutation_marker_visible'],
  };
}

function sealedMaterialAbsenceCheck(
  promptText: string,
  sealedRefs: readonly string[] | undefined,
  sealedHashes: readonly string[] | undefined,
): CogSecPersonaConformanceCheckResult {
  const refs = normalizeAnchors(sealedRefs);
  const hashes = normalizeAnchors(sealedHashes);
  const visibleRef = refs.some(ref => containsAnchor(promptText, ref));
  const visibleHash = hashes.some(hash => containsAnchor(promptText, hash));
  const attackMechanicsVisible = ATTACK_MECHANICS_PATTERN.test(promptText);
  const invisibleTextVisible = ZERO_WIDTH_OR_DIRECTIONAL_PATTERN.test(promptText);
  const reasonCodes = [
    ...(visibleRef ? ['sealed_ref_visible'] : []),
    ...(visibleHash ? ['sealed_hash_visible'] : []),
    ...(attackMechanicsVisible ? ['unsafe_instruction_marker_visible'] : []),
    ...(invisibleTextVisible ? ['invisible_text_marker_visible'] : []),
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
    reasonCodes: ['sealed_material_markers_absent'],
  };
}

function summarizeStatus(status: CogSecPersonaConformanceStatus): string {
  if (status === 'pass') return 'Persona conformance checks passed.';
  if (status === 'warning') return 'Persona conformance checks passed with warnings that need operator review.';
  return 'Persona conformance checks failed and require operator review before the CogSec case is clean.';
}

export function evaluateCogSecPersonaConformance(
  input: CogSecPersonaConformanceInput,
): CogSecPersonaConformanceEventRecord {
  const promptText = normalizeText(input.promptVisibleText);
  const stableIdentityText = normalizeText(input.stableIdentityText);
  const checks: CogSecPersonaConformanceCheckResult[] = [
    anchorCheck('voice_fidelity', promptText, input.expectedVoiceAnchors, 'voice_anchor_missing'),
    anchorCheck('value_fidelity', promptText, input.expectedValueAnchors, 'value_anchor_missing'),
    anchorCheck(
      'refusal_boundary_consistency',
      promptText,
      input.expectedRefusalAnchors,
      'refusal_boundary_anchor_missing',
    ),
    assistantGenericnessCheck(promptText, stableIdentityText),
    anchorCheck(
      'relationship_continuity',
      promptText,
      input.expectedRelationshipAnchors,
      'relationship_anchor_missing',
    ),
    unauthorizedPersonaMutationCheck(promptText),
    sealedMaterialAbsenceCheck(
      promptText,
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
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    summary: summarizeStatus(status),
    failureCount,
    warningCount,
    promptContextHash: hashText(promptText),
    checks,
  };
}
