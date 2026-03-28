import type { EventBus } from '../../../shared/event-bus.js';
import {
  cloneTurnRetrievalTelemetryRecord,
  cloneTurnSnapshotRecord,
  cloneTurnStageTelemetryRecord,
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../../turns/observability.js';
import type {
  AdminContinuityProvenanceView,
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

function buildRecordedStageTelemetry(record: AdminSessionTurnData['record']): AdminTurnStageTelemetry[] {
  return record.observability?.stages.map(cloneTurnStageTelemetryRecord) ?? [];
}

function buildRecordedRetrievalTelemetry(record: AdminSessionTurnData['record']): AdminTurnRetrievalTelemetry[] {
  return record.observability?.retrievals.map(cloneTurnRetrievalTelemetryRecord) ?? [];
}

function buildRecordedSnapshot(record: AdminSessionTurnData['record']): AdminTurnSnapshotData | null {
  const snapshot = record.observability?.snapshot;
  if (!snapshot) return null;
  return cloneTurnSnapshotRecord(snapshot);
}

function buildRecordedRoleEnvelopeRefs(record: AdminSessionTurnData['record']): string[] {
  if (!Array.isArray(record.roleEnvelopeRefs)) return [];
  return record.roleEnvelopeRefs
    .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
    .map(ref => ref.trim());
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
      this.upsertTurn(payload.snapshot.channelId, payload.snapshot.turnId).snapshot = sanitizeTurnSnapshot(payload.snapshot);
    });

    this.deps.eventBus.on('agent.turn.stage', (payload) => {
      const turn = this.upsertTurn(payload.channelId, payload.turnId);
      turn.stages.push(sanitizeTurnStageTelemetry(payload));
      this.trimTurnEventBuffer(turn.stages, this.stageBufferLimit);
    });

    this.deps.eventBus.on('memory.retrieval', (payload) => {
      const sanitized = sanitizeTurnRetrievalTelemetry(payload);
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
      roleEnvelopeRefs: buildRecordedRoleEnvelopeRefs(record),
      continuityProvenance: [] as AdminContinuityProvenanceView[],
      stages: observed?.stages.length
        ? observed.stages.map(cloneTurnStageTelemetryRecord)
        : recordedStages,
      retrievals: observed?.retrievals.length
        ? observed.retrievals.map(cloneTurnRetrievalTelemetryRecord)
        : recordedRetrievals,
      snapshot: observed?.snapshot
        ? cloneTurnSnapshotRecord(observed.snapshot)
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
