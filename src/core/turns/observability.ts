import type { EventMap } from '../../shared/event-bus.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import { cloneMemoryWithheldSummary } from '../../faculties/memory/withheld-summary.js';
import type { MemoryWithheldSummary } from '../../faculties/memory/withheld-summary.js';
import type { RecentContactShapeArtifact } from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import {
  cloneEpisodicRetrievalChain,
  type EpisodicRetrievalChain,
} from '../../faculties/memory/retrieval/episodic.js';
import type { SessionContinuityArtifact } from '../session/continuity-artifacts.js';
import type { SessionEntry } from '../session/types.js';
import {
  cloneRolledOutSessionBoundary,
  type RolledOutSessionBoundary,
} from '../session/rolled-out-session-boundary.js';
import type {
  FatigueEnforcementMetadata,
  TurnToolContextSnapshot,
  TurnPromptContextSnapshot,
  TurnPromptSnapshot,
  TurnSnapshot,
  TurnOrientationSnapshot,
} from './snapshot.js';
import {
  cloneAdaptiveToolSnapshotTelemetry,
  cloneContextMessage,
  clonePromptSectionCacheability,
  clonePromptSectionTelemetry,
  cloneProviderObservability,
  cloneOrientationSnapshot,
  cloneSessionContinuityArtifact,
  cloneTurnPromptResponseSnapshot,
  cloneToolSchema,
} from './snapshot.js';
import {
  clonePromptPlan,
  type PromptPlan,
} from '../agent/substrate-agent/turn-execution/prompt-plan.js';
import {
  isObservabilityCallType,
  type ObservabilityCallType,
} from '../../shared/contracts/observability-call-types.js';

export type ObservedMemory = Omit<PurrMemory, 'embedding'>;

export interface ObservedScoredMemory extends ObservedMemory {
  similarity: number;
}

export interface TurnSessionContextSnapshotRecord {
  channelId: string;
  recentEntries: SessionEntry[];
  autoCompactionEligible?: boolean;
  sourceEntryCount?: number;
  rolledOutSessionBoundary?: RolledOutSessionBoundary;
  historySummaryText?: string;
  historySummaryEntryCount?: number;
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  wakeReturnArtifacts?: SessionContinuityArtifact[];
  orientation?: TurnOrientationSnapshot;
  intentionAppraisalArtifactCount?: number;
  compactionPromptText?: string;
  versionPointer: string;
}

export interface TurnMemorySnapshotRecord {
  channelId: string;
  recentContactShape?: RecentContactShapeArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  contactEmotionalMemories: ObservedMemory[];
  semanticCandidates: ObservedScoredMemory[];
  lexicalCandidates: ObservedScoredMemory[];
  episodicChains?: EpisodicRetrievalChain[];
  proactiveCandidates: ObservedMemory[];
  withheldSummary?: MemoryWithheldSummary;
  versionPointer: string;
}

export interface TurnSnapshotRecord {
  turnId: string;
  requestId: string;
  channelId: string;
  capturedAt: number;
  trustLevel: string;
  canonicalContactKey?: string;
  prompt?: TurnPromptSnapshot;
  /** The turn's PromptPlan (schema-versioned): the persisted snapshot IS the plan. */
  plan?: PromptPlan;
  promptContext?: TurnPromptContextSnapshot;
  toolContext?: TurnToolContextSnapshot;
  sessionContext?: TurnSessionContextSnapshotRecord;
  memory?: TurnMemorySnapshotRecord;
  biographicalProjection?: {
    admittedClaimIds: string[];
    withheldCount: number;
    contextChars: number;
  };
  fatigue?: FatigueEnforcementMetadata;
}

export interface TurnStageTelemetryRecord {
  observedAt: number;
  turnId: string;
  requestId?: string;
  channelId: string;
  callType?: ObservabilityCallType;
  purpose?: string;
  stage: string;
  elapsedMs: number;
  data: Record<string, unknown>;
}

export interface TurnRetrievalTelemetryRecord {
  observedAt: number;
  turnId: string;
  requestId?: string;
  channelId: string;
  callType?: ObservabilityCallType;
  purpose?: string;
  count: number;
  reason?: string;
  retrievalSource?: 'embedding' | 'lexical_fallback';
  data: Record<string, unknown>;
}

export interface TurnObservabilityRecord {
  stages: TurnStageTelemetryRecord[];
  retrievals: TurnRetrievalTelemetryRecord[];
  snapshot?: TurnSnapshotRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecentContactShapeArtifact(
  shape: RecentContactShapeArtifact,
): RecentContactShapeArtifact {
  return {
    ...shape,
    sourceMemoryIds: [...shape.sourceMemoryIds],
  };
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return { ...entry };
}

export function cloneUnknownValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneUnknownValue(item)) as T;
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const cloned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = cloneUnknownValue(item);
  }
  return cloned as T;
}

function cloneShallowRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneUnknownValue(value);
}

export function sanitizeObservedMemory(memory: PurrMemory): ObservedMemory {
  const { embedding: _embedding, ...rest } = memory;
  return {
    ...rest,
    tags: [...memory.tags],
    ...(memory.provenanceRefs ? { provenanceRefs: [...memory.provenanceRefs] } : {}),
    ...(memory.consentFlags ? { consentFlags: { ...memory.consentFlags } } : {}),
    ...(memory.formationVAD ? { formationVAD: { ...memory.formationVAD } } : {}),
  };
}

function sanitizeObservedScoredMemory(
  memory: PurrMemory & { similarity: number },
): ObservedScoredMemory {
  return {
    ...sanitizeObservedMemory(memory),
    similarity: memory.similarity,
  };
}

function cloneObservedMemory(memory: ObservedMemory): ObservedMemory {
  return {
    ...memory,
    tags: [...memory.tags],
    ...(memory.provenanceRefs ? { provenanceRefs: [...memory.provenanceRefs] } : {}),
    ...(memory.consentFlags ? { consentFlags: { ...memory.consentFlags } } : {}),
    ...(memory.formationVAD ? { formationVAD: { ...memory.formationVAD } } : {}),
  };
}

function cloneObservedScoredMemory(memory: ObservedScoredMemory): ObservedScoredMemory {
  return {
    ...cloneObservedMemory(memory),
    similarity: memory.similarity,
  };
}

function filterObservedMemories<T extends PurrMemory>(
  memories: readonly T[] | undefined,
  withheldIds: ReadonlySet<string>,
): T[] {
  if (!Array.isArray(memories)) return [];
  if (withheldIds.size === 0) return [...memories];
  return memories.filter(memory => !withheldIds.has(memory.id));
}

// Nested cloners shared by sanitizeTurnSnapshot (live snapshot -> record) and
// cloneTurnSnapshotRecord (record -> record). Each explicitly projects the
// record shape, so a live snapshot's extra fields are dropped identically on
// both paths. Only memory candidate lists differ (filter+sanitize vs clone).

function clonePromptSnapshotRecord(prompt: TurnPromptSnapshot): TurnPromptSnapshot {
  return {
    ...prompt,
    ...(prompt.sectionCacheability
      ? { sectionCacheability: prompt.sectionCacheability.map(clonePromptSectionCacheability) }
      : {}),
  };
}

function clonePromptContextSnapshotRecord(promptContext: TurnPromptContextSnapshot): TurnPromptContextSnapshot {
  return {
    ...promptContext,
    ...(promptContext.currentTurnInput !== undefined
      ? { currentTurnInput: promptContext.currentTurnInput }
      : {}),
    ...(promptContext.providerObservability
      ? { providerObservability: cloneProviderObservability(promptContext.providerObservability) }
      : {}),
    ...(promptContext.response
      ? { response: cloneTurnPromptResponseSnapshot(promptContext.response) }
      : {}),
    ...(promptContext.sectionCacheability
      ? { sectionCacheability: promptContext.sectionCacheability.map(clonePromptSectionCacheability) }
      : {}),
    ...(promptContext.inputSections
      ? { inputSections: promptContext.inputSections.map(clonePromptSectionTelemetry) }
      : {}),
    ...(promptContext.runtimeContextSections
      ? { runtimeContextSections: promptContext.runtimeContextSections.map(clonePromptSectionTelemetry) }
      : {}),
    ...(promptContext.memoryContextSections
      ? { memoryContextSections: promptContext.memoryContextSections.map(clonePromptSectionTelemetry) }
      : {}),
    ...(promptContext.finalSystemSections
      ? { finalSystemSections: promptContext.finalSystemSections.map(clonePromptSectionTelemetry) }
      : {}),
  };
}

function cloneToolContextSnapshotRecord(toolContext: TurnToolContextSnapshot): TurnToolContextSnapshot {
  return {
    // Preserve absence: slim persisted snapshots omit activeTools when
    // byte-identical to plan.toolDefinitions (readers fall back to the plan).
    ...(toolContext.activeTools
      ? { activeTools: toolContext.activeTools.map(cloneToolSchema) }
      : {}),
    ...(toolContext.adaptiveSnapshot
      ? { adaptiveSnapshot: cloneAdaptiveToolSnapshotTelemetry(toolContext.adaptiveSnapshot)! }
      : {}),
  };
}

function cloneSessionContextSnapshotRecord(
  sessionContext: TurnSessionContextSnapshotRecord,
): TurnSessionContextSnapshotRecord {
  return {
    channelId: sessionContext.channelId,
    recentEntries: sessionContext.recentEntries.map(cloneSessionEntry),
    ...(sessionContext.autoCompactionEligible !== undefined
      ? { autoCompactionEligible: sessionContext.autoCompactionEligible }
      : {}),
    ...(sessionContext.sourceEntryCount !== undefined
      ? { sourceEntryCount: sessionContext.sourceEntryCount }
      : {}),
    ...(sessionContext.rolledOutSessionBoundary
      ? { rolledOutSessionBoundary: cloneRolledOutSessionBoundary(sessionContext.rolledOutSessionBoundary) }
      : {}),
    ...(sessionContext.historySummaryText
      ? { historySummaryText: sessionContext.historySummaryText }
      : {}),
    ...(sessionContext.historySummaryEntryCount !== undefined
      ? { historySummaryEntryCount: sessionContext.historySummaryEntryCount }
      : {}),
    compactionSummaryTexts: [...sessionContext.compactionSummaryTexts],
    focusKnowledgeTexts: [...sessionContext.focusKnowledgeTexts],
    continuityEntries: sessionContext.continuityEntries.map(cloneSessionEntry),
    ...(sessionContext.wakeReturnArtifacts
      ? { wakeReturnArtifacts: sessionContext.wakeReturnArtifacts.map(cloneSessionContinuityArtifact) }
      : {}),
    ...(sessionContext.orientation
      ? { orientation: cloneOrientationSnapshot(sessionContext.orientation) }
      : {}),
    ...(sessionContext.intentionAppraisalArtifactCount !== undefined
      ? { intentionAppraisalArtifactCount: sessionContext.intentionAppraisalArtifactCount }
      : {}),
    ...(sessionContext.compactionPromptText
      ? { compactionPromptText: sessionContext.compactionPromptText }
      : {}),
    versionPointer: sessionContext.versionPointer,
  };
}

type TurnMemoryCandidateLists = Pick<
  TurnMemorySnapshotRecord,
  'contactEmotionalMemories' | 'semanticCandidates' | 'lexicalCandidates' | 'proactiveCandidates'
>;

type TurnMemorySharedFields = Pick<
  TurnMemorySnapshotRecord,
  'channelId' | 'recentContactShape' | 'emotionalSnapshot' | 'episodicChains' | 'withheldSummary' | 'versionPointer'
>;

function buildMemorySnapshotRecord(
  memory: TurnMemorySharedFields,
  candidates: TurnMemoryCandidateLists,
): TurnMemorySnapshotRecord {
  return {
    channelId: memory.channelId,
    ...(memory.recentContactShape
      ? { recentContactShape: cloneRecentContactShapeArtifact(memory.recentContactShape) }
      : {}),
    ...(memory.emotionalSnapshot ? { emotionalSnapshot: { ...memory.emotionalSnapshot } } : {}),
    contactEmotionalMemories: candidates.contactEmotionalMemories,
    semanticCandidates: candidates.semanticCandidates,
    lexicalCandidates: candidates.lexicalCandidates,
    ...(memory.episodicChains
      ? { episodicChains: memory.episodicChains.map(cloneEpisodicRetrievalChain) }
      : {}),
    proactiveCandidates: candidates.proactiveCandidates,
    ...(memory.withheldSummary
      ? { withheldSummary: cloneMemoryWithheldSummary(memory.withheldSummary) }
      : {}),
    versionPointer: memory.versionPointer,
  };
}

type TurnSnapshotNestedFields = Pick<
  TurnSnapshotRecord,
  'prompt' | 'plan' | 'promptContext' | 'toolContext' | 'sessionContext' | 'biographicalProjection' | 'fatigue'
>;

function cloneSharedSnapshotSections(snapshot: TurnSnapshotNestedFields): TurnSnapshotNestedFields {
  return {
    ...(snapshot.prompt ? { prompt: clonePromptSnapshotRecord(snapshot.prompt) } : {}),
    ...(snapshot.plan
      ? { plan: clonePromptPlan(snapshot.plan, cloneContextMessage, cloneToolSchema) }
      : {}),
    ...(snapshot.promptContext
      ? { promptContext: clonePromptContextSnapshotRecord(snapshot.promptContext) }
      : {}),
    ...(snapshot.toolContext
      ? { toolContext: cloneToolContextSnapshotRecord(snapshot.toolContext) }
      : {}),
    ...(snapshot.sessionContext
      ? { sessionContext: cloneSessionContextSnapshotRecord(snapshot.sessionContext) }
      : {}),
  };
}

function cloneTrailingSnapshotSections(snapshot: TurnSnapshotNestedFields): TurnSnapshotNestedFields {
  return {
    ...(snapshot.biographicalProjection
      ? {
        biographicalProjection: {
          ...snapshot.biographicalProjection,
          admittedClaimIds: [...snapshot.biographicalProjection.admittedClaimIds],
        },
      }
      : {}),
    ...(snapshot.fatigue ? { fatigue: cloneUnknownValue(snapshot.fatigue) } : {}),
  };
}

export function sanitizeTurnSnapshot(snapshot: TurnSnapshot): TurnSnapshotRecord {
  const withheldIds = new Set(snapshot.memory?.withheldCandidateIds ?? []);
  const memory = snapshot.memory;
  return {
    turnId: snapshot.turnId,
    requestId: snapshot.requestId,
    channelId: snapshot.channelId,
    capturedAt: snapshot.capturedAt,
    trustLevel: snapshot.trustLevel,
    ...(snapshot.canonicalContactKey ? { canonicalContactKey: snapshot.canonicalContactKey } : {}),
    ...cloneSharedSnapshotSections(snapshot),
    ...(memory
      ? {
        memory: buildMemorySnapshotRecord(memory, {
          contactEmotionalMemories: filterObservedMemories(memory.contactEmotionalMemories, withheldIds)
            .map(sanitizeObservedMemory),
          semanticCandidates: filterObservedMemories(memory.semanticCandidates, withheldIds)
            .map(sanitizeObservedScoredMemory),
          lexicalCandidates: filterObservedMemories(memory.lexicalCandidates, withheldIds)
            .map(sanitizeObservedScoredMemory),
          proactiveCandidates: filterObservedMemories(memory.proactiveCandidates, withheldIds)
            .map(sanitizeObservedMemory),
        }),
      }
      : {}),
    ...cloneTrailingSnapshotSections(snapshot),
  };
}

export function cloneTurnSnapshotRecord(snapshot: TurnSnapshotRecord): TurnSnapshotRecord {
  const memory = snapshot.memory;
  return {
    ...snapshot,
    ...cloneSharedSnapshotSections(snapshot),
    ...(memory
      ? {
        memory: buildMemorySnapshotRecord(memory, {
          contactEmotionalMemories: memory.contactEmotionalMemories.map(cloneObservedMemory),
          semanticCandidates: memory.semanticCandidates.map(cloneObservedScoredMemory),
          lexicalCandidates: memory.lexicalCandidates.map(cloneObservedScoredMemory),
          proactiveCandidates: memory.proactiveCandidates.map(cloneObservedMemory),
        }),
      }
      : {}),
    ...cloneTrailingSnapshotSections(snapshot),
  };
}

export function sanitizeTurnStageTelemetry(payload: EventMap['agent.turn.stage']): TurnStageTelemetryRecord {
  const {
    turnId,
    requestId,
    channelId,
    callType,
    purpose,
    stage,
    elapsedMs,
    ...data
  } = payload as EventMap['agent.turn.stage'] & Record<string, unknown>;
  return {
    observedAt: Date.now(),
    turnId,
    ...(typeof requestId === 'string' && requestId.trim().length > 0 ? { requestId: requestId.trim() } : {}),
    channelId,
    ...(isObservabilityCallType(callType) ? { callType } : {}),
    ...(typeof purpose === 'string' && purpose.trim().length > 0 ? { purpose: purpose.trim() } : {}),
    stage,
    elapsedMs,
    data: cloneShallowRecord(data),
  };
}

export function cloneTurnStageTelemetryRecord(payload: TurnStageTelemetryRecord): TurnStageTelemetryRecord {
  return {
    ...payload,
    data: cloneShallowRecord(payload.data),
  };
}

export function sanitizeTurnRetrievalTelemetry(
  payload: EventMap['memory.retrieval'],
): TurnRetrievalTelemetryRecord | null {
  if (typeof payload.turnId !== 'string' || payload.turnId.trim().length === 0) {
    return null;
  }

  const {
    turnId,
    requestId,
    channelId,
    callType,
    purpose,
    count,
    reason,
    retrievalSource,
    ...data
  } = payload as EventMap['memory.retrieval'] & Record<string, unknown>;
  const normalizedTurnId = payload.turnId.trim();

  return {
    observedAt: Date.now(),
    turnId: normalizedTurnId,
    ...(typeof requestId === 'string' && requestId.trim().length > 0 ? { requestId: requestId.trim() } : {}),
    channelId,
    ...(isObservabilityCallType(callType) ? { callType } : {}),
    ...(typeof purpose === 'string' && purpose.trim().length > 0 ? { purpose: purpose.trim() } : {}),
    count,
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    ...(retrievalSource ? { retrievalSource } : {}),
    data: cloneShallowRecord(data),
  };
}

export function cloneTurnRetrievalTelemetryRecord(
  payload: TurnRetrievalTelemetryRecord,
): TurnRetrievalTelemetryRecord {
  return {
    ...payload,
    data: cloneShallowRecord(payload.data),
  };
}

export function cloneTurnObservabilityRecord(record: TurnObservabilityRecord): TurnObservabilityRecord {
  return {
    stages: record.stages.map(cloneTurnStageTelemetryRecord),
    retrievals: record.retrievals.map(cloneTurnRetrievalTelemetryRecord),
    ...(record.snapshot ? { snapshot: cloneTurnSnapshotRecord(record.snapshot) } : {}),
  };
}
