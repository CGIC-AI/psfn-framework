import type {
  GroupMemoryWriteAddressModeWeights,
  GroupMemoryWriteCapSettings,
} from '../../../system/config/group-memory-config.js';
import type {
  ExtractedFact,
  GroupMemoryAddressMode,
  MemoryScopeRef,
} from '../types.js';
import type {
  AcceptedFactCandidate,
  GroupMemoryWriteCapSkip,
  GroupMemoryWriteCapSkipReason,
} from './types.js';

export interface GroupMemoryWriteCandidateRouting {
  contactId?: string;
  sourceContactId?: string;
  subjectContactId?: string;
  addressMode?: GroupMemoryAddressMode;
  scopeRef?: MemoryScopeRef;
}

export type GroupMemoryWriteCandidate = AcceptedFactCandidate & {
  routing: GroupMemoryWriteCandidateRouting;
};

export interface GroupMemoryWriteSelectionOptions<
  TCandidate extends GroupMemoryWriteCandidate,
> {
  candidates: readonly TCandidate[];
  settings: GroupMemoryWriteCapSettings;
  backfill?: boolean;
  recentTimeWindowWriteCount?: number;
}

export interface GroupMemoryWriteSelectionTelemetry {
  candidateCount: number;
  selectedCount: number;
  skippedCount: number;
  effectiveMaxWrites: number;
  skips: GroupMemoryWriteCapSkip[];
}

export interface GroupMemoryWriteSelection<
  TCandidate extends GroupMemoryWriteCandidate,
> {
  selectedCandidates: TCandidate[];
  skippedCandidates: TCandidate[];
  telemetry: GroupMemoryWriteSelectionTelemetry;
}

interface SelectionState {
  selectedCount: number;
  selectedLowSalienceCount: number;
  contactCounts: Map<string, number>;
  subjectCounts: Map<string, number>;
  coveredKeys: Set<string>;
}

interface CapDecision {
  reason: GroupMemoryWriteCapSkipReason;
  configuredLimit: number;
  contactId?: string;
  subjectContactId?: string;
  className?: string;
  scopeRef?: MemoryScopeRef;
}

const ADDRESS_MODE_CONFIG_KEYS: Record<
  GroupMemoryAddressMode,
  keyof GroupMemoryWriteAddressModeWeights
> = {
  direct_to_companion: 'directToCompanion',
  mention_of_companion: 'mentionOfCompanion',
  reply_to_user: 'replyToUser',
  overheard_room_context: 'overheardRoomContext',
  system_api: 'systemApi',
};

export function selectGroupMemoryWriteCandidates<
  TCandidate extends GroupMemoryWriteCandidate,
>(
  options: GroupMemoryWriteSelectionOptions<TCandidate>,
): GroupMemoryWriteSelection<TCandidate> {
  const remaining = [...options.candidates];
  const selectedCandidates: TCandidate[] = [];
  const skippedCandidates: TCandidate[] = [];
  const skipAccumulator = new WriteCapSkipAccumulator();
  const state: SelectionState = {
    selectedCount: 0,
    selectedLowSalienceCount: 0,
    contactCounts: new Map(),
    subjectCounts: new Map(),
    coveredKeys: new Set(),
  };

  while (remaining.length > 0) {
    const nextIndex = pickNextCandidateIndex(
      remaining,
      options.settings,
      state.coveredKeys,
    );
    const candidate = remaining.splice(nextIndex, 1)[0];
    const cap = findBlockingCap(candidate, state, options);
    if (cap) {
      skippedCandidates.push(candidate);
      skipAccumulator.record(cap);
      continue;
    }

    selectedCandidates.push(candidate);
    recordSelectedCandidate(candidate, state, options.settings);
  }

  const effectiveMaxWrites = computeEffectiveMaxWrites(options);
  return {
    selectedCandidates,
    skippedCandidates,
    telemetry: {
      candidateCount: options.candidates.length,
      selectedCount: selectedCandidates.length,
      skippedCount: skippedCandidates.length,
      effectiveMaxWrites,
      skips: skipAccumulator.toSkips(),
    },
  };
}

export function computeGroupMemoryWriteCandidateScore(
  candidate: GroupMemoryWriteCandidate,
  settings: GroupMemoryWriteCapSettings,
  coveredKeys: ReadonlySet<string> = new Set(),
): number {
  const weights = settings.rankingWeights;
  const fact = candidate.fact;
  const coverageKey = resolveCoverageKey(candidate);
  const coverageScore = coverageKey && !coveredKeys.has(coverageKey) ? 1 : 0;
  const addressModeScore = candidate.routing.addressMode
    ? settings.addressModeWeights[
      ADDRESS_MODE_CONFIG_KEYS[candidate.routing.addressMode]
    ]
    : 0;

  return (
    fact.importance * weights.importance
    + candidate.novelty * weights.novelty
    + fact.confidence * weights.confidence
    + addressModeScore * weights.addressMode
    + relationshipRelevanceScore(fact) * weights.relationshipRelevance
    + Math.abs(fact.emotionalValence) * weights.emotionalIntensity
    + coverageScore * weights.perContactCoverage
  );
}

function pickNextCandidateIndex<TCandidate extends GroupMemoryWriteCandidate>(
  candidates: readonly TCandidate[],
  settings: GroupMemoryWriteCapSettings,
  coveredKeys: ReadonlySet<string>,
): number {
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, candidate] of candidates.entries()) {
    const score = computeGroupMemoryWriteCandidateScore(
      candidate,
      settings,
      coveredKeys,
    );
    if (
      score > bestScore
      || (
        score === bestScore
        && compareCandidateTieBreakers(candidate, candidates[bestIndex]) < 0
      )
    ) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function compareCandidateTieBreakers(
  left: GroupMemoryWriteCandidate,
  right: GroupMemoryWriteCandidate,
): number {
  if (right.valueScore !== left.valueScore) return right.valueScore - left.valueScore;
  if (right.fact.importance !== left.fact.importance) {
    return right.fact.importance - left.fact.importance;
  }
  if (right.fact.confidence !== left.fact.confidence) {
    return right.fact.confidence - left.fact.confidence;
  }
  if (right.novelty !== left.novelty) return right.novelty - left.novelty;
  return left.index - right.index;
}

function findBlockingCap<TCandidate extends GroupMemoryWriteCandidate>(
  candidate: TCandidate,
  state: SelectionState,
  options: GroupMemoryWriteSelectionOptions<TCandidate>,
): CapDecision | null {
  const settings = options.settings;
  const contactKey = resolveContactKey(candidate);
  const subjectKey = resolveSubjectKey(candidate);
  const scopeRef = candidate.routing.scopeRef;

  if (state.selectedCount >= settings.maxWritesPerRun) {
    return {
      reason: 'run_cap',
      configuredLimit: settings.maxWritesPerRun,
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (state.selectedCount >= settings.maxWritesPerChunk) {
    return {
      reason: 'chunk_cap',
      configuredLimit: settings.maxWritesPerChunk,
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (
    options.backfill === true
    && state.selectedCount >= settings.maxWritesPerBackfillRun
  ) {
    return {
      reason: 'backfill_cap',
      configuredLimit: settings.maxWritesPerBackfillRun,
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (
    options.recentTimeWindowWriteCount !== undefined
    && state.selectedCount >= remainingTimeWindowWrites(settings, options)
  ) {
    return {
      reason: 'time_window_cap',
      configuredLimit: settings.maxWritesPerTimeWindow,
      className: `window:${settings.timeWindowMs}ms`,
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (
    isLowSalience(candidate.fact, settings)
    && state.selectedLowSalienceCount >= settings.maxLowSalienceWritesPerRun
  ) {
    return {
      reason: 'low_salience_cap',
      configuredLimit: settings.maxLowSalienceWritesPerRun,
      className: 'low_salience',
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (
    contactKey
    && (state.contactCounts.get(contactKey) ?? 0) >= settings.maxWritesPerContact
  ) {
    return {
      reason: 'contact_cap',
      configuredLimit: settings.maxWritesPerContact,
      contactId: contactKey,
      ...(subjectKey ? { subjectContactId: subjectKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }
  if (
    subjectKey
    && (state.subjectCounts.get(subjectKey) ?? 0) >= settings.maxWritesPerSubject
  ) {
    return {
      reason: 'subject_cap',
      configuredLimit: settings.maxWritesPerSubject,
      subjectContactId: subjectKey,
      ...(contactKey ? { contactId: contactKey } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    };
  }

  return null;
}

function recordSelectedCandidate(
  candidate: GroupMemoryWriteCandidate,
  state: SelectionState,
  settings: GroupMemoryWriteCapSettings,
): void {
  state.selectedCount += 1;
  if (isLowSalience(candidate.fact, settings)) {
    state.selectedLowSalienceCount += 1;
  }

  const contactKey = resolveContactKey(candidate);
  if (contactKey) {
    state.contactCounts.set(contactKey, (state.contactCounts.get(contactKey) ?? 0) + 1);
  }
  const subjectKey = resolveSubjectKey(candidate);
  if (subjectKey) {
    state.subjectCounts.set(subjectKey, (state.subjectCounts.get(subjectKey) ?? 0) + 1);
  }
  const coverageKey = resolveCoverageKey(candidate);
  if (coverageKey) state.coveredKeys.add(coverageKey);
}

function computeEffectiveMaxWrites<TCandidate extends GroupMemoryWriteCandidate>(
  options: GroupMemoryWriteSelectionOptions<TCandidate>,
): number {
  const limits = [
    options.settings.maxWritesPerRun,
    options.settings.maxWritesPerChunk,
  ];
  if (options.backfill === true) {
    limits.push(options.settings.maxWritesPerBackfillRun);
  }
  if (options.recentTimeWindowWriteCount !== undefined) {
    limits.push(remainingTimeWindowWrites(options.settings, options));
  }
  return Math.max(0, Math.min(...limits));
}

function remainingTimeWindowWrites<TCandidate extends GroupMemoryWriteCandidate>(
  settings: GroupMemoryWriteCapSettings,
  options: GroupMemoryWriteSelectionOptions<TCandidate>,
): number {
  return Math.max(
    0,
    settings.maxWritesPerTimeWindow - (options.recentTimeWindowWriteCount ?? 0),
  );
}

function isLowSalience(
  fact: ExtractedFact,
  settings: GroupMemoryWriteCapSettings,
): boolean {
  return fact.importance < settings.lowSalienceThreshold;
}

function relationshipRelevanceScore(fact: ExtractedFact): number {
  if (fact.type === 'relational') return 1;
  return fact.tags.some(tag => normalizeTag(tag).includes('relationship')) ? 1 : 0;
}

function resolveContactKey(candidate: GroupMemoryWriteCandidate): string | undefined {
  return candidate.routing.contactId
    ?? candidate.routing.sourceContactId
    ?? undefined;
}

function resolveSubjectKey(candidate: GroupMemoryWriteCandidate): string | undefined {
  return candidate.routing.subjectContactId
    ?? candidate.routing.contactId
    ?? undefined;
}

function resolveCoverageKey(candidate: GroupMemoryWriteCandidate): string | undefined {
  const contactKey = resolveContactKey(candidate);
  if (contactKey) return `contact:${contactKey}`;
  const subjectKey = resolveSubjectKey(candidate);
  if (subjectKey) return `subject:${subjectKey}`;
  if (candidate.routing.scopeRef) {
    return `scope:${candidate.routing.scopeRef.kind}:${candidate.routing.scopeRef.id}`;
  }
  return undefined;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

class WriteCapSkipAccumulator {
  private readonly records = new Map<string, GroupMemoryWriteCapSkip>();

  record(decision: CapDecision): void {
    const key = `${decision.reason}:${decision.configuredLimit}`;
    const current = this.records.get(key) ?? {
      reason: decision.reason,
      skippedCount: 0,
      configuredLimit: decision.configuredLimit,
    };
    current.skippedCount += 1;
    if (decision.contactId) {
      current.affectedContactIds = appendUnique(
        current.affectedContactIds,
        decision.contactId,
      );
    }
    if (decision.subjectContactId) {
      current.affectedSubjectContactIds = appendUnique(
        current.affectedSubjectContactIds,
        decision.subjectContactId,
      );
    }
    if (decision.className) {
      current.affectedClasses = appendUnique(
        current.affectedClasses,
        decision.className,
      );
    }
    if (decision.scopeRef) {
      current.affectedScopeRefs = appendScopeRef(
        current.affectedScopeRefs,
        decision.scopeRef,
      );
    }
    this.records.set(key, current);
  }

  toSkips(): GroupMemoryWriteCapSkip[] {
    return [...this.records.values()]
      .map(skip => {
        const normalized: GroupMemoryWriteCapSkip = {
          reason: skip.reason,
          skippedCount: skip.skippedCount,
          configuredLimit: skip.configuredLimit,
        };
        if (skip.affectedContactIds && skip.affectedContactIds.length > 0) {
          normalized.affectedContactIds = [...skip.affectedContactIds].sort();
        }
        if (
          skip.affectedSubjectContactIds
          && skip.affectedSubjectContactIds.length > 0
        ) {
          normalized.affectedSubjectContactIds = [
            ...skip.affectedSubjectContactIds,
          ].sort();
        }
        if (skip.affectedClasses && skip.affectedClasses.length > 0) {
          normalized.affectedClasses = [...skip.affectedClasses].sort();
        }
        if (skip.affectedScopeRefs && skip.affectedScopeRefs.length > 0) {
          normalized.affectedScopeRefs = [...skip.affectedScopeRefs];
        }
        return normalized;
      })
      .sort((left, right) => left.reason.localeCompare(right.reason));
  }
}

function appendUnique<TValue>(
  values: TValue[] | undefined,
  value: TValue,
): TValue[] {
  const next = values ? [...values] : [];
  if (!next.includes(value)) next.push(value);
  return next;
}

function appendScopeRef(
  values: MemoryScopeRef[] | undefined,
  value: MemoryScopeRef,
): MemoryScopeRef[] {
  const next = values ? [...values] : [];
  if (!next.some(existing => (
    existing.kind === value.kind
    && existing.id === value.id
    && existing.label === value.label
  ))) {
    next.push(value);
  }
  return next;
}
