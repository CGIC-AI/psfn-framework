import type { EventBus } from '../../../shared/event-bus.js';
import {
  cloneUnknownValue,
  cloneTurnRetrievalTelemetryRecord,
  cloneTurnSnapshotRecord,
  cloneTurnStageTelemetryRecord,
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../../core/turns/observability.js';
import type {
  AdminContinuityProvenanceView,
  AdminPromptLoomData,
  AdminPromptLoomHistoricalSnapshotHit,
  AdminSessionTurnData,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from './types.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';

const DEFAULT_TURN_BUFFER_LIMIT = 128;
const DEFAULT_STAGE_BUFFER_LIMIT = 16;
const DEFAULT_RETRIEVAL_BUFFER_LIMIT = 8;
const HISTORICAL_SNAPSHOT_LABEL = 'Persisted turn snapshot; not current prompt generator state.';
const REMOVED_PROMPT_LAYER_IDS = [
  'runtime_self',
  'model_context',
  'analysis_workbench_guidance',
] as const;

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

function cloneProviderMessages(snapshot: AdminTurnSnapshotData | null): AdminPromptLoomData['providerPayload']['providerMessages'] {
  return snapshot?.promptContext?.providerObservability?.providerWireMessages.map(message => ({ ...message })) ?? [];
}

function cloneActiveTools(snapshot: AdminTurnSnapshotData | null): AdminPromptLoomData['providerPayload']['activeTools'] {
  return snapshot?.toolContext?.activeTools.map(tool => ({
    ...tool,
    inputSchema: cloneUnknownValue(tool.inputSchema),
  })) ?? [];
}

function clonePromptSections(
  sections: AdminPromptLoomData['generatedPrompt']['inputSections'] | undefined,
): AdminPromptLoomData['generatedPrompt']['inputSections'] {
  return sections?.map(section => cloneUnknownValue(section)) ?? [];
}

function historicalLayerMatches(text: string | null | undefined, layerId: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return normalized.includes(layerId) || normalized.includes(layerId.replaceAll('_', ' '));
}

function addHistoricalHitsForText(
  hits: AdminPromptLoomHistoricalSnapshotHit[],
  source: string,
  text: string | null | undefined,
): void {
  for (const layerId of REMOVED_PROMPT_LAYER_IDS) {
    if (historicalLayerMatches(text, layerId)) {
      hits.push({ layerId, source });
    }
  }
}

function addHistoricalHitsForSections(
  hits: AdminPromptLoomHistoricalSnapshotHit[],
  source: string,
  sections: AdminPromptLoomData['generatedPrompt']['inputSections'] | undefined,
): void {
  for (const section of sections ?? []) {
    for (const layerId of REMOVED_PROMPT_LAYER_IDS) {
      if (
        historicalLayerMatches(section.id, layerId)
        || historicalLayerMatches(section.title, layerId)
        || historicalLayerMatches(section.content, layerId)
      ) {
        hits.push({
          layerId,
          source,
          sectionId: section.id,
          title: section.title,
        });
      }
    }
  }
}

function collectHistoricalSnapshotHits(snapshot: AdminTurnSnapshotData | null): AdminPromptLoomHistoricalSnapshotHit[] {
  const hits: AdminPromptLoomHistoricalSnapshotHit[] = [];
  addHistoricalHitsForText(hits, 'prompt.staticPrefixTemplate', snapshot?.prompt?.staticPrefixTemplate);
  addHistoricalHitsForText(hits, 'prompt.dynamicSuffixTemplate', snapshot?.prompt?.dynamicSuffixTemplate);
  addHistoricalHitsForSections(hits, 'promptContext.inputSections', snapshot?.promptContext?.inputSections);
  addHistoricalHitsForSections(
    hits,
    'promptContext.runtimeContextSections',
    snapshot?.promptContext?.runtimeContextSections,
  );
  addHistoricalHitsForSections(
    hits,
    'promptContext.finalSystemSections',
    snapshot?.promptContext?.finalSystemSections,
  );
  return hits;
}

function hasToolResultPayload(toolCall: TurnRecord['toolCalls'][number]): boolean {
  const record = toolCall as Record<string, unknown>;
  return typeof record.resultText === 'string'
    || typeof record.isError === 'boolean'
    || record.details !== undefined;
}

function buildPromptLoomData(
  record: TurnRecord,
  snapshot: AdminTurnSnapshotData | null,
): AdminPromptLoomData {
  const promptContext = snapshot?.promptContext;
  const response = promptContext?.response ?? null;
  const renderedChatOutput = response?.content ?? record.assistantMessage?.content ?? null;
  const historicalHits = collectHistoricalSnapshotHits(snapshot);
  return {
    source: 'turn_snapshot',
    snapshotCapturedAt: snapshot?.capturedAt ?? null,
    historicalSnapshot: {
      label: HISTORICAL_SNAPSHOT_LABEL,
      removedPromptLayerIds: [...new Set(historicalHits.map(hit => hit.layerId))],
      hits: historicalHits,
    },
    generatedPrompt: {
      renderedStaticPrefix: promptContext?.renderedStaticPrefix ?? null,
      renderedDynamicSuffix: promptContext?.renderedDynamicSuffix ?? null,
      runtimeContext: promptContext?.runtimeContext ?? null,
      memoryContextBlock: promptContext?.memoryContextBlock ?? null,
      scratchpadContext: promptContext?.scratchpadContext ?? null,
      assembledPrompt: promptContext?.assembledPrompt ?? null,
      contextMessages: promptContext?.messages.map(message => cloneUnknownValue(message)) ?? [],
      inputSections: clonePromptSections(promptContext?.inputSections),
      runtimeContextSections: clonePromptSections(promptContext?.runtimeContextSections),
      finalSystemSections: clonePromptSections(promptContext?.finalSystemSections),
    },
    providerPayload: {
      finalSystemPrompt: promptContext?.finalSystemPrompt ?? null,
      providerMessages: cloneProviderMessages(snapshot),
      activeTools: cloneActiveTools(snapshot),
    },
    providerResult: {
      response: response ? { ...response } : null,
      renderedChatOutput,
    },
    memoryCapture: {
      input: {
        currentTurnInput: promptContext?.currentTurnInput ?? null,
        userMessage: { ...record.userMessage },
        ...(record.assistantMessage ? { assistantMessage: { ...record.assistantMessage } } : {}),
        renderedChatOutput,
      },
      output: {
        extractedMemoryIds: [...record.extractedMemoryIds],
      },
    },
    toolActivity: {
      toolCalls: record.toolCalls.map(toolCall => cloneUnknownValue(toolCall)),
      toolResults: record.toolCalls
        .filter(hasToolResultPayload)
        .map(toolCall => cloneUnknownValue(toolCall)),
    },
  };
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
    const snapshot = observed?.snapshot
      ? cloneTurnSnapshotRecord(observed.snapshot)
      : recordedSnapshot;
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
      snapshot,
      promptLoom: buildPromptLoomData(record, snapshot),
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
