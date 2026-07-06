import type { ObservabilityCallType } from '../../shared/contracts/runtime.js';
import type { SessionEntry } from '../session/types.js';
import {
  MASKED_TOOL_OBSERVATION_CONTENT,
  parseToolObservationMetadata,
} from '../session/tool-observation.js';
import type { TurnRetrievalTelemetryRecord } from './observability.js';
import type { TurnMemorySnapshot, TurnSnapshot } from './snapshot.js';
import { getPromptPlanBlockText } from '../agent/substrate-agent/turn-execution/prompt-plan.js';
import { clipSnippet, normalizeWhitespace } from '../../shared/utils/snippets.js';

const REFLECTION_PROVENANCE_PREFIXES = ['reflection:', 'internal:reflection:', 'values:'] as const;
const RECENT_LIVE_ACTIVITY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLAIM_SNIPPET_MAX_CHARS = 180;
const STALE_TOOL_NAME_LIMIT = 6;
const CLAIM_SOURCE_LIMIT = 6;
const INACTIVITY_CLAIM_PATTERNS = [
  /\b(?:haven't|have not|hasn't|has not)\s+(?:heard|seen|talked|spoken|chatted|connected)\s+(?:from|with)\b/i,
  /\b(?:days?|weeks?|months?)\s+since\s+(?:we|i|they|the user)?\s*(?:last\s+)?(?:heard|saw|talked|spoke|chatted)\b/i,
  /\b(?:no|without)\s+(?:recent|new)\s+(?:activity|contact|messages?|conversation)\b/i,
  /\b(?:quiet|silent|inactive)\s+(?:for\s+\d+\s+(?:days?|weeks?|months?)|lately)\b/i,
  /\bit(?:'s| has)?\s+been\s+(?:about\s+)?\d+\s+(?:days?|weeks?|months?)\s+since\b/i,
];

export type TurnObservabilityWarningCode =
  | 'history_span_exceeded'
  | 'temporal_reflection_only_retrieval'
  | 'stale_tool_observation_verbatim'
  | 'values_activity_contradiction';

export interface TurnObservabilityWarning {
  code: TurnObservabilityWarningCode;
  severity: 'warning';
  message: string;
  details: Record<string, unknown>;
}

export interface TurnObservabilityWarningSummary {
  warnings: TurnObservabilityWarning[];
  counters: Record<string, number>;
}

export function detectTurnObservabilityWarnings(input: {
  callType: ObservabilityCallType;
  nowMs: number;
  maxHistorySpanMs: number;
  temporalRetrievalMode: boolean;
  snapshot?: TurnSnapshot;
  retrievals: readonly TurnRetrievalTelemetryRecord[];
}): TurnObservabilityWarningSummary {
  if (input.callType !== 'chat') {
    return { warnings: [], counters: {} };
  }

  const warnings: TurnObservabilityWarning[] = [];
  const counters: Record<string, number> = {};
  const sessionContext = input.snapshot?.sessionContext;
  const memorySnapshot = input.snapshot?.memory;

  const historySpanWarning = detectHistorySpanWarning(sessionContext?.recentEntries ?? [], input.maxHistorySpanMs);
  if (historySpanWarning) {
    warnings.push(historySpanWarning.warning);
    counters.historySpanExceededCount = historySpanWarning.count;
  }

  const reflectionOnlyWarning = detectTemporalReflectionOnlyRetrievalWarning({
    temporalRetrievalMode: input.temporalRetrievalMode,
    retrievals: input.retrievals,
  });
  if (reflectionOnlyWarning) {
    warnings.push(reflectionOnlyWarning.warning);
    counters.temporalReflectionOnlyRetrievalCount = reflectionOnlyWarning.count;
  }

  const staleToolWarning = detectStaleToolObservationWarning({
    entries: sessionContext?.recentEntries ?? [],
    nowMs: input.nowMs,
    staleAfterMs: input.maxHistorySpanMs,
  });
  if (staleToolWarning) {
    warnings.push(staleToolWarning.warning);
    counters.staleToolObservationVerbatimCount = staleToolWarning.count;
  }

  const valuesContradictionWarning = detectValuesActivityContradictionWarning({
    sessionContext,
    memorySnapshot,
    renderedDynamicSuffix: input.snapshot?.plan
      ? getPromptPlanBlockText(input.snapshot.plan, 'dynamic_suffix')
      : '',
    nowMs: input.nowMs,
  });
  if (valuesContradictionWarning) {
    warnings.push(valuesContradictionWarning.warning);
    counters.valuesActivityContradictionCount = valuesContradictionWarning.count;
  }

  if (warnings.length > 0) {
    counters.warningCount = warnings.length;
  }

  return {
    warnings,
    counters,
  };
}

function detectHistorySpanWarning(
  entries: readonly SessionEntry[],
  maxHistorySpanMs: number,
): { warning: TurnObservabilityWarning; count: number } | null {
  const timestamps = entries
    .map(entry => entry.timestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp) && timestamp > 0)
    .sort((left, right) => left - right);
  if (timestamps.length < 2) {
    return null;
  }

  const oldestTimestamp = timestamps[0]!;
  const newestTimestamp = timestamps[timestamps.length - 1]!;
  const actualSpanMs = Math.max(0, newestTimestamp - oldestTimestamp);
  if (actualSpanMs <= maxHistorySpanMs) {
    return null;
  }

  return {
    count: 1,
    warning: {
      code: 'history_span_exceeded',
      severity: 'warning',
      message: 'Chat turn context spans beyond the configured wall-clock history window.',
      details: {
        actualSpanMs,
        maxHistorySpanMs,
        overflowMs: actualSpanMs - maxHistorySpanMs,
        recentEntryCount: entries.length,
        oldestTimestamp,
        newestTimestamp,
      },
    },
  };
}

function detectTemporalReflectionOnlyRetrievalWarning(input: {
  temporalRetrievalMode: boolean;
  retrievals: readonly TurnRetrievalTelemetryRecord[];
}): { warning: TurnObservabilityWarning; count: number } | null {
  if (!input.temporalRetrievalMode) {
    return null;
  }

  let totalRetrievedCount = 0;
  let reflectionRetrievedCount = 0;
  let nonReflectionRetrievedCount = 0;
  const selectedTypesAggregate: Partial<Record<string, number>> = {};

  for (const retrieval of input.retrievals) {
    if (retrieval.count <= 0) {
      continue;
    }
    const selectedTypes = readCountRecord(retrieval.data.selectedTypes);
    if (selectedTypes) {
      for (const [type, rawCount] of Object.entries(selectedTypes)) {
        const count = Math.max(0, Math.floor(rawCount));
        if (count <= 0) continue;
        selectedTypesAggregate[type] = (selectedTypesAggregate[type] ?? 0) + count;
        totalRetrievedCount += count;
        if (type === 'reflection') {
          reflectionRetrievedCount += count;
        } else {
          nonReflectionRetrievedCount += count;
        }
      }
      continue;
    }

    const provenanceRefs = readStringArray(retrieval.data.provenanceRefs);
    if (provenanceRefs.length > 0 && provenanceRefs.every(isReflectionProvenanceRef)) {
      totalRetrievedCount += retrieval.count;
      reflectionRetrievedCount += retrieval.count;
      selectedTypesAggregate.reflection = (selectedTypesAggregate.reflection ?? 0) + retrieval.count;
    }
  }

  if (
    totalRetrievedCount === 0
    || reflectionRetrievedCount === 0
    || nonReflectionRetrievedCount > 0
    || reflectionRetrievedCount !== totalRetrievedCount
  ) {
    return null;
  }

  return {
    count: reflectionRetrievedCount,
    warning: {
      code: 'temporal_reflection_only_retrieval',
      severity: 'warning',
      message: 'Temporal retrieval resolved only reflection-type memories.',
      details: {
        totalRetrievedCount,
        reflectionRetrievedCount,
        retrievalEventCount: input.retrievals.length,
        selectedTypes: selectedTypesAggregate,
      },
    },
  };
}

function detectStaleToolObservationWarning(input: {
  entries: readonly SessionEntry[];
  nowMs: number;
  staleAfterMs: number;
}): { warning: TurnObservabilityWarning; count: number } | null {
  const staleEntries = input.entries
    .filter(entry => entry.role === 'tool')
    .flatMap((entry) => {
      const ageMs = Math.max(0, input.nowMs - entry.timestamp);
      if (entry.content === MASKED_TOOL_OBSERVATION_CONTENT || ageMs <= input.staleAfterMs) {
        return [];
      }

      try {
        const metadata = parseToolObservationMetadata(entry.metadata);
        if (!metadata || metadata.contextDisplayMode !== 'full') {
          return [];
        }
        return [{
          entryId: entry.id,
          toolName: metadata.toolName,
          ageMs,
          timestamp: entry.timestamp,
        }];
      } catch {
        return [];
      }
    });

  if (staleEntries.length === 0) {
    return null;
  }

  return {
    count: staleEntries.length,
    warning: {
      code: 'stale_tool_observation_verbatim',
      severity: 'warning',
      message: 'Stale tool observations remained verbatim in chat context.',
      details: {
        staleObservationCount: staleEntries.length,
        staleAfterMs: input.staleAfterMs,
        oldestAgeMs: Math.max(...staleEntries.map(entry => entry.ageMs)),
        toolNames: [...new Set(staleEntries.map(entry => entry.toolName))].slice(0, STALE_TOOL_NAME_LIMIT),
        entryIds: staleEntries.map(entry => entry.entryId),
      },
    },
  };
}

function detectValuesActivityContradictionWarning(input: {
  sessionContext: TurnSnapshot['sessionContext'] | undefined;
  memorySnapshot: TurnSnapshot['memory'] | undefined;
  renderedDynamicSuffix: string;
  nowMs: number;
}): { warning: TurnObservabilityWarning; count: number } | null {
  const latestLiveActivity = resolveLatestLiveActivity(input.sessionContext);
  if (!latestLiveActivity) {
    return null;
  }

  const activityAgeMs = Math.max(0, input.nowMs - latestLiveActivity.timestamp);
  if (activityAgeMs > RECENT_LIVE_ACTIVITY_MAX_AGE_MS) {
    return null;
  }

  const claimMatches = [
    ...collectValuesLayerClaimMatches(input.renderedDynamicSuffix),
    ...collectReflectionMemoryClaimMatches(input.memorySnapshot),
  ];
  if (claimMatches.length === 0) {
    return null;
  }

  return {
    count: claimMatches.length,
    warning: {
      code: 'values_activity_contradiction',
      severity: 'warning',
      message: 'Values or reflection claims conflict with recent live-activity signals.',
      details: {
        contradictionCount: claimMatches.length,
        latestActivityTimestamp: latestLiveActivity.timestamp,
        latestActivityAgeMs: activityAgeMs,
        activitySignalCount: latestLiveActivity.signalCount,
        claimSources: [...new Set(claimMatches.map(match => match.source))].slice(0, CLAIM_SOURCE_LIMIT),
        claimSnippets: claimMatches.map(match => match.snippet).slice(0, CLAIM_SOURCE_LIMIT),
      },
    },
  };
}

function resolveLatestLiveActivity(
  sessionContext: TurnSnapshot['sessionContext'] | undefined,
): { timestamp: number; signalCount: number } | null {
  if (!sessionContext) {
    return null;
  }

  const activityEntries = [
    ...sessionContext.recentEntries,
    ...sessionContext.continuityEntries,
  ].filter((entry) => (
    (entry.role === 'user' || entry.role === 'assistant')
    && Number.isFinite(entry.timestamp)
    && entry.timestamp > 0
  ));
  if (activityEntries.length === 0) {
    return null;
  }

  return {
    timestamp: Math.max(...activityEntries.map(entry => entry.timestamp)),
    signalCount: activityEntries.length,
  };
}

function collectValuesLayerClaimMatches(renderedDynamicSuffix: string): ClaimMatch[] {
  const normalized = normalizeWhitespace(renderedDynamicSuffix);
  if (!normalized.includes('[Companion-Derived Values Layer]')) {
    return [];
  }
  const matches = findInactivityClaimMatches(normalized);
  return matches.map(match => ({
    source: 'values_layer' as const,
    snippet: clipSnippet(match, CLAIM_SNIPPET_MAX_CHARS),
  }));
}

function collectReflectionMemoryClaimMatches(
  memorySnapshot: TurnMemorySnapshot | undefined,
): ClaimMatch[] {
  if (!memorySnapshot) {
    return [];
  }

  const candidates = [
    ...memorySnapshot.contactEmotionalMemories,
    ...memorySnapshot.semanticCandidates,
    ...memorySnapshot.lexicalCandidates,
    ...memorySnapshot.proactiveCandidates,
  ].filter(isReflectionCandidate);

  return candidates.flatMap(memory => findInactivityClaimMatches(memory.text).map(match => ({
    source: 'reflection_memory' as const,
    snippet: clipSnippet(match, CLAIM_SNIPPET_MAX_CHARS),
  })));
}

function isReflectionCandidate(
  memory: Pick<TurnMemorySnapshot['contactEmotionalMemories'][number], 'type' | 'sourceRef' | 'provenanceRefs'>,
): boolean {
  if (memory.type === 'reflection') {
    return true;
  }
  if (isReflectionProvenanceRef(memory.sourceRef)) {
    return true;
  }
  return (memory.provenanceRefs ?? []).some(isReflectionProvenanceRef);
}

function isReflectionProvenanceRef(value: string): boolean {
  return REFLECTION_PROVENANCE_PREFIXES.some(prefix => value.startsWith(prefix));
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

function readCountRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      continue;
    }
    result[key] = Math.floor(raw);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean);
}

interface ClaimMatch {
  source: 'values_layer' | 'reflection_memory';
  snippet: string;
}
