import type { EventMap } from '../event-bus.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import { cloneMemoryWithheldSummary } from '../memory/withheld-summary.js';
import type { MemoryWithheldSummary } from '../memory/withheld-summary.js';
import type { ContactProfileArtifact } from '../memory/store.js';
import type { PurrMemory } from '../memory/types.js';
import type { SessionEntry } from '../session/types.js';
import type {
  TurnToolContextSnapshot,
  TurnPromptContextSnapshot,
  TurnPromptSnapshot,
  TurnSnapshot,
} from './snapshot.js';
import {
  cloneAdaptiveToolSnapshotTelemetry,
  cloneContextMessage,
  cloneProviderObservability,
  cloneToolSchema,
} from './snapshot.js';

export type TurnObservabilityCallType =
  | 'chat'
  | 'tool'
  | 'memory'
  | 'summary'
  | 'background'
  | 'scheduled';

export type ObservedMemory = Omit<PurrMemory, 'embedding'>;

export interface ObservedScoredMemory extends ObservedMemory {
  similarity: number;
}

export interface TurnSessionContextSnapshotRecord {
  channelId: string;
  recentEntries: SessionEntry[];
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  intentionAppraisalArtifactCount?: number;
  compactionPromptText?: string;
  versionPointer: string;
}

export interface TurnMemorySnapshotRecord {
  channelId: string;
  profile?: ContactProfileArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  contactEmotionalMemories: ObservedMemory[];
  semanticCandidates: ObservedScoredMemory[];
  lexicalCandidates: ObservedScoredMemory[];
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
  promptContext?: TurnPromptContextSnapshot;
  toolContext?: TurnToolContextSnapshot;
  sessionContext?: TurnSessionContextSnapshotRecord;
  memory?: TurnMemorySnapshotRecord;
}

export interface TurnStageTelemetryRecord {
  observedAt: number;
  turnId: string;
  requestId?: string;
  channelId: string;
  callType?: TurnObservabilityCallType;
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
  callType?: TurnObservabilityCallType;
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

function cloneContactProfileArtifact(profile: ContactProfileArtifact): ContactProfileArtifact {
  return {
    ...profile,
    sourceMemoryIds: [...profile.sourceMemoryIds],
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

function sanitizeObservedMemory(memory: PurrMemory): ObservedMemory {
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

export function sanitizeTurnSnapshot(snapshot: TurnSnapshot): TurnSnapshotRecord {
  const withheldIds = new Set(snapshot.memory?.withheldCandidateIds ?? []);
  return {
    turnId: snapshot.turnId,
    requestId: snapshot.requestId,
    channelId: snapshot.channelId,
    capturedAt: snapshot.capturedAt,
    trustLevel: snapshot.trustLevel,
    ...(snapshot.canonicalContactKey ? { canonicalContactKey: snapshot.canonicalContactKey } : {}),
    ...(snapshot.prompt
      ? {
        prompt: {
          ...snapshot.prompt,
        },
      }
      : {}),
    ...(snapshot.promptContext
      ? {
        promptContext: {
          ...snapshot.promptContext,
          messages: snapshot.promptContext.messages.map(cloneContextMessage),
          ...(snapshot.promptContext.providerObservability
            ? { providerObservability: cloneProviderObservability(snapshot.promptContext.providerObservability) }
            : {}),
        },
      }
      : {}),
    ...(snapshot.toolContext
      ? {
        toolContext: {
          activeTools: snapshot.toolContext.activeTools.map(cloneToolSchema),
          ...(snapshot.toolContext.adaptiveSnapshot
            ? { adaptiveSnapshot: cloneAdaptiveToolSnapshotTelemetry(snapshot.toolContext.adaptiveSnapshot)! }
            : {}),
        },
      }
      : {}),
    ...(snapshot.sessionContext
      ? {
        sessionContext: {
          channelId: snapshot.sessionContext.channelId,
          recentEntries: snapshot.sessionContext.recentEntries.map(cloneSessionEntry),
          compactionSummaryTexts: [...snapshot.sessionContext.compactionSummaryTexts],
          focusKnowledgeTexts: [...snapshot.sessionContext.focusKnowledgeTexts],
          continuityEntries: snapshot.sessionContext.continuityEntries.map(cloneSessionEntry),
          ...(snapshot.sessionContext.intentionAppraisalArtifactCount !== undefined
            ? { intentionAppraisalArtifactCount: snapshot.sessionContext.intentionAppraisalArtifactCount }
            : {}),
          ...(snapshot.sessionContext.compactionPromptText
            ? { compactionPromptText: snapshot.sessionContext.compactionPromptText }
            : {}),
          versionPointer: snapshot.sessionContext.versionPointer,
        },
      }
      : {}),
    ...(snapshot.memory
      ? {
        memory: {
          channelId: snapshot.memory.channelId,
          ...(snapshot.memory.profile ? { profile: cloneContactProfileArtifact(snapshot.memory.profile) } : {}),
          ...(snapshot.memory.emotionalSnapshot ? { emotionalSnapshot: { ...snapshot.memory.emotionalSnapshot } } : {}),
          contactEmotionalMemories: filterObservedMemories(
            snapshot.memory.contactEmotionalMemories,
            withheldIds,
          ).map(sanitizeObservedMemory),
          semanticCandidates: filterObservedMemories(
            snapshot.memory.semanticCandidates,
            withheldIds,
          ).map(sanitizeObservedScoredMemory),
          lexicalCandidates: filterObservedMemories(
            snapshot.memory.lexicalCandidates,
            withheldIds,
          ).map(sanitizeObservedScoredMemory),
          proactiveCandidates: filterObservedMemories(
            snapshot.memory.proactiveCandidates,
            withheldIds,
          ).map(sanitizeObservedMemory),
          ...(snapshot.memory.withheldSummary
            ? { withheldSummary: cloneMemoryWithheldSummary(snapshot.memory.withheldSummary) }
            : {}),
          versionPointer: snapshot.memory.versionPointer,
        },
      }
      : {}),
  };
}

export function cloneTurnSnapshotRecord(snapshot: TurnSnapshotRecord): TurnSnapshotRecord {
  return {
    ...snapshot,
    ...(snapshot.prompt ? { prompt: { ...snapshot.prompt } } : {}),
    ...(snapshot.promptContext
      ? {
        promptContext: {
          ...snapshot.promptContext,
          messages: snapshot.promptContext.messages.map(cloneContextMessage),
          ...(snapshot.promptContext.providerObservability
            ? { providerObservability: cloneProviderObservability(snapshot.promptContext.providerObservability) }
            : {}),
        },
      }
      : {}),
    ...(snapshot.toolContext
      ? {
        toolContext: {
          activeTools: snapshot.toolContext.activeTools.map(cloneToolSchema),
          ...(snapshot.toolContext.adaptiveSnapshot
            ? { adaptiveSnapshot: cloneAdaptiveToolSnapshotTelemetry(snapshot.toolContext.adaptiveSnapshot)! }
            : {}),
        },
      }
      : {}),
    ...(snapshot.sessionContext
      ? {
        sessionContext: {
          channelId: snapshot.sessionContext.channelId,
          recentEntries: snapshot.sessionContext.recentEntries.map(cloneSessionEntry),
          compactionSummaryTexts: [...snapshot.sessionContext.compactionSummaryTexts],
          focusKnowledgeTexts: [...snapshot.sessionContext.focusKnowledgeTexts],
          continuityEntries: snapshot.sessionContext.continuityEntries.map(cloneSessionEntry),
          ...(snapshot.sessionContext.intentionAppraisalArtifactCount !== undefined
            ? { intentionAppraisalArtifactCount: snapshot.sessionContext.intentionAppraisalArtifactCount }
            : {}),
          ...(snapshot.sessionContext.compactionPromptText
            ? { compactionPromptText: snapshot.sessionContext.compactionPromptText }
            : {}),
          versionPointer: snapshot.sessionContext.versionPointer,
        },
      }
      : {}),
    ...(snapshot.memory
      ? {
        memory: {
          channelId: snapshot.memory.channelId,
          ...(snapshot.memory.profile ? { profile: cloneContactProfileArtifact(snapshot.memory.profile) } : {}),
          ...(snapshot.memory.emotionalSnapshot ? { emotionalSnapshot: { ...snapshot.memory.emotionalSnapshot } } : {}),
          contactEmotionalMemories: snapshot.memory.contactEmotionalMemories.map(cloneObservedMemory),
          semanticCandidates: snapshot.memory.semanticCandidates.map(cloneObservedScoredMemory),
          lexicalCandidates: snapshot.memory.lexicalCandidates.map(cloneObservedScoredMemory),
          proactiveCandidates: snapshot.memory.proactiveCandidates.map(cloneObservedMemory),
          ...(snapshot.memory.withheldSummary
            ? { withheldSummary: cloneMemoryWithheldSummary(snapshot.memory.withheldSummary) }
            : {}),
          versionPointer: snapshot.memory.versionPointer,
        },
      }
      : {}),
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
    ...(typeof callType === 'string' ? { callType: callType as TurnObservabilityCallType } : {}),
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

  return {
    observedAt: Date.now(),
    turnId: turnId.trim(),
    ...(typeof requestId === 'string' && requestId.trim().length > 0 ? { requestId: requestId.trim() } : {}),
    channelId,
    ...(typeof callType === 'string' ? { callType: callType as TurnObservabilityCallType } : {}),
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
