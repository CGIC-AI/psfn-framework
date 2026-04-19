export const REFLECTION_GUARDRAIL_RECENT_CHAT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const REFLECTION_CADENCE_DRIFT_RATIO_THRESHOLD = 4;
const CLAIM_SNIPPET_MAX_CHARS = 180;
const INACTIVITY_CLAIM_PATTERNS = [
  /\b(?:haven't|have not|hasn't|has not)\s+(?:heard|seen|talked|spoken|chatted|connected)\s+(?:from|with)\b/i,
  /\b(?:days?|weeks?|months?)\s+since\s+(?:we|i|they|the user)?\s*(?:last\s+)?(?:heard|saw|talked|spoke|chatted)\b/i,
  /\b(?:no|without)\s+(?:recent|new)\s+(?:activity|contact|messages?|conversation)\b/i,
  /\b(?:quiet|silent|inactive)\s+(?:for\s+\d+\s+(?:days?|weeks?|months?)|lately)\b/i,
  /\bit(?:'s| has)?\s+been\s+(?:about\s+)?\d+\s+(?:days?|weeks?|months?)\s+since\b/i,
] as const;

export type ReflectionGuardrailWarningCode =
  | 'null_canonical_contact'
  | 'reflection_cadence_drift'
  | 'stale_silence_claim'
  | 'missing_internal_state_snapshot'
  | 'scheduler_bound_internal_state';

export type ReflectionGuardrailSnapshotSource =
  | 'missing'
  | 'runtime'
  | 'derived_runtime'
  | 'response'
  | 'derived_response';

export interface ReflectionGuardrailWarning {
  code: ReflectionGuardrailWarningCode;
  severity: 'warning';
  message: string;
  details: Record<string, unknown>;
}

export interface ReflectionGuardrailSummary {
  warnings: ReflectionGuardrailWarning[];
  counters: Record<string, number>;
}

export interface ReflectionGuardrailInput {
  templateIntervalMs: number;
  canonicalContactId?: string;
  primarySessionId?: string;
  recentMessageCount: number;
  freshestLiveChatGapMs?: number;
  latestLiveActivityAgeMs?: number;
  reflectionText: string;
  internalStateSnapshotRef?: string;
  snapshotSource: ReflectionGuardrailSnapshotSource;
  internalStateContactId?: string;
}

export function detectReflectionGuardrailWarnings(
  input: ReflectionGuardrailInput,
): ReflectionGuardrailSummary {
  const warnings: ReflectionGuardrailWarning[] = [];
  const counters: Record<string, number> = {};

  if (!input.canonicalContactId) {
    warnings.push({
      code: 'null_canonical_contact',
      severity: 'warning',
      message: 'Reflection ran without a canonical contact binding.',
      details: {
        recentMessageCount: input.recentMessageCount,
        ...(input.primarySessionId ? { primarySessionId: input.primarySessionId } : {}),
      },
    });
    counters.nullCanonicalContactCount = 1;
  }

  if (
    Number.isFinite(input.freshestLiveChatGapMs)
    && input.freshestLiveChatGapMs !== undefined
    && input.templateIntervalMs > 0
  ) {
    const cadenceRatio = input.freshestLiveChatGapMs / input.templateIntervalMs;
    if (cadenceRatio >= REFLECTION_CADENCE_DRIFT_RATIO_THRESHOLD) {
      warnings.push({
        code: 'reflection_cadence_drift',
        severity: 'warning',
        message: 'Reflection cadence materially exceeds recent live-chat cadence.',
        details: {
          reflectionIntervalMs: input.templateIntervalMs,
          liveChatGapMs: Math.floor(input.freshestLiveChatGapMs),
          cadenceRatio: Number(cadenceRatio.toFixed(2)),
          ...(input.primarySessionId ? { primarySessionId: input.primarySessionId } : {}),
        },
      });
      counters.reflectionCadenceDriftCount = 1;
    }
  }

  const staleClaimMatches = (
    input.recentMessageCount > 0
    && Number.isFinite(input.latestLiveActivityAgeMs)
    && input.latestLiveActivityAgeMs !== undefined
    && input.latestLiveActivityAgeMs <= REFLECTION_GUARDRAIL_RECENT_CHAT_MAX_AGE_MS
  )
    ? findInactivityClaimMatches(input.reflectionText)
    : [];
  if (staleClaimMatches.length > 0) {
    warnings.push({
      code: 'stale_silence_claim',
      severity: 'warning',
      message: 'Reflection asserted silence despite recent live-chat evidence.',
      details: {
        claimSnippets: staleClaimMatches.map(clipSnippet),
        recentMessageCount: input.recentMessageCount,
        latestLiveActivityAgeMs: Math.floor(input.latestLiveActivityAgeMs ?? 0),
        ...(input.primarySessionId ? { primarySessionId: input.primarySessionId } : {}),
      },
    });
    counters.staleSilenceClaimCount = staleClaimMatches.length;
  }

  if (input.snapshotSource === 'missing' || input.snapshotSource.startsWith('derived_')) {
    warnings.push({
      code: 'missing_internal_state_snapshot',
      severity: 'warning',
      message: 'Reflection internal-state snapshot metadata was missing and had to be synthesized.',
      details: {
        snapshotSource: input.snapshotSource,
        ...(input.internalStateSnapshotRef ? { internalStateSnapshotRef: input.internalStateSnapshotRef } : {}),
      },
    });
    counters.missingInternalStateSnapshotCount = 1;
  }

  if (
    input.snapshotSource !== 'missing'
    && input.canonicalContactId
    && input.internalStateContactId !== input.canonicalContactId
  ) {
    warnings.push({
      code: 'scheduler_bound_internal_state',
      severity: 'warning',
      message: 'Reflection internal-state snapshot is not bound to the canonical contact.',
      details: {
        expectedCanonicalContactId: input.canonicalContactId,
        actualSnapshotContactId: input.internalStateContactId ?? null,
        snapshotSource: input.snapshotSource,
        ...(input.internalStateSnapshotRef ? { internalStateSnapshotRef: input.internalStateSnapshotRef } : {}),
      },
    });
    counters.schedulerBoundInternalStateCount = 1;
  }

  if (warnings.length > 0) {
    counters.warningCount = warnings.length;
  }

  return {
    warnings,
    counters,
  };
}

function findInactivityClaimMatches(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const matches = new Set<string>();
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (INACTIVITY_CLAIM_PATTERNS.some(pattern => pattern.test(sentence))) {
      matches.add(sentence);
    }
  }

  return [...matches];
}

function clipSnippet(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= CLAIM_SNIPPET_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, CLAIM_SNIPPET_MAX_CHARS - 3)}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
