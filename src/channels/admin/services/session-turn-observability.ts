import type { EventMap, EventBus } from '../../../event-bus.js';
import { cloneMemoryWithheldSummary } from '../../../memory/withheld-summary.js';
import type { ContactProfileArtifact } from '../../../memory/store.js';
import type { PurrMemory } from '../../../memory/types.js';
import type { SessionEntry } from '../../../session/types.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import type {
  AdminObservedMemory,
  AdminObservedScoredMemory,
  AdminSessionTurnData,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from './types.js';

const DEFAULT_TURN_BUFFER_LIMIT = 128;
const DEFAULT_STAGE_BUFFER_LIMIT = 16;
const DEFAULT_RETRIEVAL_BUFFER_LIMIT = 8;

interface ObservedTurnData {
  channelId: string;
  turnId: string;
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
  snapshot: AdminTurnSnapshotData | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneContactProfileArtifact(profile: ContactProfileArtifact): ContactProfileArtifact {
  return {
    ...profile,
    ...(profile.sourceMemoryIds ? { sourceMemoryIds: [...profile.sourceMemoryIds] } : {}),
  };
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return { ...entry };
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknownValue);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const cloned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = cloneUnknownValue(item);
  }
  return cloned;
}

function cloneShallowRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneUnknownValue(value) as Record<string, unknown>;
}

function sanitizeObservedMemory(memory: PurrMemory): AdminObservedMemory {
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
): AdminObservedScoredMemory {
  return {
    ...sanitizeObservedMemory(memory),
    similarity: memory.similarity,
  };
}

function cloneObservedMemory(memory: AdminObservedMemory): AdminObservedMemory {
  return {
    ...memory,
    tags: [...memory.tags],
    ...(memory.provenanceRefs ? { provenanceRefs: [...memory.provenanceRefs] } : {}),
    ...(memory.consentFlags ? { consentFlags: { ...memory.consentFlags } } : {}),
    ...(memory.formationVAD ? { formationVAD: { ...memory.formationVAD } } : {}),
  };
}

function cloneObservedScoredMemory(memory: AdminObservedScoredMemory): AdminObservedScoredMemory {
  return {
    ...cloneObservedMemory(memory),
    similarity: memory.similarity,
  };
}

function filterObservedMemories<T extends PurrMemory>(
  memories: readonly T[],
  withheldIds: ReadonlySet<string>,
): T[] {
  if (withheldIds.size === 0) return [...memories];
  return memories.filter(memory => !withheldIds.has(memory.id));
}

function sanitizeSnapshot(snapshot: TurnSnapshot): AdminTurnSnapshotData {
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
    ...(snapshot.sessionContext
      ? {
        sessionContext: {
          channelId: snapshot.sessionContext.channelId,
          recentEntries: snapshot.sessionContext.recentEntries.map(cloneSessionEntry),
          compactionSummaryTexts: [...snapshot.sessionContext.compactionSummaryTexts],
          focusKnowledgeTexts: [...snapshot.sessionContext.focusKnowledgeTexts],
          continuityEntries: snapshot.sessionContext.continuityEntries.map(cloneSessionEntry),
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

function cloneSnapshot(snapshot: AdminTurnSnapshotData): AdminTurnSnapshotData {
  return {
    ...snapshot,
    ...(snapshot.prompt ? { prompt: { ...snapshot.prompt } } : {}),
    ...(snapshot.sessionContext
      ? {
        sessionContext: {
          channelId: snapshot.sessionContext.channelId,
          recentEntries: snapshot.sessionContext.recentEntries.map(cloneSessionEntry),
          compactionSummaryTexts: [...snapshot.sessionContext.compactionSummaryTexts],
          focusKnowledgeTexts: [...snapshot.sessionContext.focusKnowledgeTexts],
          continuityEntries: snapshot.sessionContext.continuityEntries.map(cloneSessionEntry),
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

function sanitizeStageTelemetry(payload: EventMap['agent.turn.stage']): AdminTurnStageTelemetry {
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
    ...(typeof callType === 'string' ? { callType } : {}),
    ...(typeof purpose === 'string' && purpose.trim().length > 0 ? { purpose: purpose.trim() } : {}),
    stage,
    elapsedMs,
    data: cloneShallowRecord(data),
  };
}

function sanitizeRetrievalTelemetry(payload: EventMap['memory.retrieval']): AdminTurnRetrievalTelemetry | null {
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
    ...(typeof callType === 'string' ? { callType } : {}),
    ...(typeof purpose === 'string' && purpose.trim().length > 0 ? { purpose: purpose.trim() } : {}),
    count,
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    ...(retrievalSource ? { retrievalSource } : {}),
    data: cloneShallowRecord(data),
  };
}

function cloneStageTelemetry(payload: AdminTurnStageTelemetry): AdminTurnStageTelemetry {
  return {
    ...payload,
    data: cloneShallowRecord(payload.data),
  };
}

function cloneRetrievalTelemetry(payload: AdminTurnRetrievalTelemetry): AdminTurnRetrievalTelemetry {
  return {
    ...payload,
    data: cloneShallowRecord(payload.data),
  };
}

function buildRecordedStageTelemetry(record: AdminSessionTurnData['record']): AdminTurnStageTelemetry[] {
  return record.observability?.stages.map(stage => ({
    observedAt: record.completedAt,
    turnId: record.turnId,
    requestId: record.requestId,
    channelId: record.channelId,
    purpose: `agent.turn.stage.${stage.stage}`,
    stage: stage.stage,
    elapsedMs: stage.elapsedMs,
    data: cloneShallowRecord(stage.details as Record<string, unknown>),
  })) ?? [];
}

function buildRecordedRetrievalTelemetry(record: AdminSessionTurnData['record']): AdminTurnRetrievalTelemetry[] {
  const retrieval = record.observability?.retrieval;
  if (!retrieval) return [];

  const {
    count,
    reason,
    retrievalSource,
    ...data
  } = retrieval as typeof retrieval & Record<string, unknown>;

  return [{
    observedAt: record.completedAt,
    turnId: record.turnId,
    requestId: record.requestId,
    channelId: record.channelId,
    purpose: 'memory.retrieval',
    count,
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    ...(retrievalSource ? { retrievalSource } : {}),
    data: cloneShallowRecord(data),
  }];
}

function buildRecordedSnapshot(record: AdminSessionTurnData['record']): AdminTurnSnapshotData | null {
  const snapshot = record.observability?.snapshot;
  if (!snapshot) return null;
  return cloneUnknownValue(snapshot) as AdminTurnSnapshotData;
}

export class AdminSessionTurnObservabilityStore {
  private readonly turnBufferLimit: number;
  private readonly stageBufferLimit: number;
  private readonly retrievalBufferLimit: number;
  private readonly turnsById = new Map<string, ObservedTurnData>();
  private readonly turnIdsByChannel = new Map<string, string[]>();

  constructor(private readonly deps: {
    eventBus: EventBus;
    turnBufferLimit?: number;
    stageBufferLimit?: number;
    retrievalBufferLimit?: number;
  }) {
    this.turnBufferLimit = Number.isFinite(deps.turnBufferLimit)
      ? Math.max(1, Math.floor(deps.turnBufferLimit as number))
      : DEFAULT_TURN_BUFFER_LIMIT;
    this.stageBufferLimit = Number.isFinite(deps.stageBufferLimit)
      ? Math.max(1, Math.floor(deps.stageBufferLimit as number))
      : DEFAULT_STAGE_BUFFER_LIMIT;
    this.retrievalBufferLimit = Number.isFinite(deps.retrievalBufferLimit)
      ? Math.max(1, Math.floor(deps.retrievalBufferLimit as number))
      : DEFAULT_RETRIEVAL_BUFFER_LIMIT;

    this.deps.eventBus.on('agent.turn.snapshot', (payload) => {
      this.upsertTurn(payload.snapshot.channelId, payload.snapshot.turnId).snapshot = sanitizeSnapshot(payload.snapshot);
    });

    this.deps.eventBus.on('agent.turn.stage', (payload) => {
      const turn = this.upsertTurn(payload.channelId, payload.turnId);
      turn.stages.push(sanitizeStageTelemetry(payload));
      this.trimTurnEventBuffer(turn.stages, this.stageBufferLimit);
    });

    this.deps.eventBus.on('memory.retrieval', (payload) => {
      const sanitized = sanitizeRetrievalTelemetry(payload);
      if (!sanitized) return;
      const turn = this.upsertTurn(payload.channelId, sanitized.turnId);
      turn.retrievals.push(sanitized);
      this.trimTurnEventBuffer(turn.retrievals, this.retrievalBufferLimit);
    });
  }

  buildTurnData(record: AdminSessionTurnData['record']): AdminSessionTurnData {
    const observed = this.turnsById.get(record.turnId);
    const recordedStages = buildRecordedStageTelemetry(record);
    const recordedRetrievals = buildRecordedRetrievalTelemetry(record);
    const recordedSnapshot = buildRecordedSnapshot(record);
    return {
      record,
      stages: observed?.stages.length
        ? observed.stages.map(cloneStageTelemetry)
        : recordedStages,
      retrievals: observed?.retrievals.length
        ? observed.retrievals.map(cloneRetrievalTelemetry)
        : recordedRetrievals,
      snapshot: observed?.snapshot
        ? cloneSnapshot(observed.snapshot)
        : recordedSnapshot,
    };
  }

  private upsertTurn(channelId: string, turnId: string): ObservedTurnData {
    const existing = this.turnsById.get(turnId);
    if (existing) {
      if (existing.channelId !== channelId) {
        existing.channelId = channelId;
      }
      this.trackChannelTurn(channelId, turnId);
      return existing;
    }

    const created: ObservedTurnData = {
      channelId,
      turnId,
      stages: [],
      retrievals: [],
      snapshot: null,
    };
    this.turnsById.set(turnId, created);
    this.trackChannelTurn(channelId, turnId);
    return created;
  }

  private trackChannelTurn(channelId: string, turnId: string): void {
    const existing = this.turnIdsByChannel.get(channelId) ?? [];
    if (!existing.includes(turnId)) {
      existing.push(turnId);
      this.turnIdsByChannel.set(channelId, existing);
    }

    if (existing.length <= this.turnBufferLimit) {
      return;
    }

    const overflow = existing.splice(0, existing.length - this.turnBufferLimit);
    for (const overflowTurnId of overflow) {
      this.turnsById.delete(overflowTurnId);
    }
  }

  private trimTurnEventBuffer<T>(entries: T[], limit: number): void {
    if (entries.length <= limit) return;
    entries.splice(0, entries.length - limit);
  }
}
