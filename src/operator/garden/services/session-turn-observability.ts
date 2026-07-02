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
  AdminPromptLoomProviderWireData,
  AdminSessionTurnData,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from './types.js';
import type { ContextMessage, TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  getPromptPlanBlockText,
  renderPromptPlanAssembledPrompt,
  serializePromptPlanForProvider,
  serializePromptPlanSystemPrompt,
} from '../../../core/agent/substrate-agent/turn-execution/prompt-plan.js';

/**
 * Truncation-point inventory (bead psfn-framework-u9jo.2).
 *
 * Every point between the assembled prompt and the rendered Loom view where
 * content could shrink, with its classification:
 *   (a) display cap   — UI-only, full content still present upstream
 *   (b) storage cap   — content dropped before/at storage
 *   (c) real prompt   — the prompt genuinely carried less (by design)
 *
 * 1. Snapshot capture (turn-execution/prompt-assembly.ts + agent-invocation.ts):
 *    captures the FULL provider system prompt, every provider wire message, and
 *    every prompt block verbatim. No content cap. → not a truncation point.
 * 2. Event bus (shared/event-bus.ts): in-process typed bus, structuredClone
 *    delivery, no payload size limit. → not a truncation point.
 * 3. Sanitize/clone (core/turns/observability.ts + snapshot.ts): deep clones;
 *    the only subtraction is policy-withheld memory candidates, already
 *    disclosed via memory.withheldSummary. → not a content truncation point.
 * 4. In-memory admin buffers (THIS FILE): DEFAULT_TURN_BUFFER_LIMIT /
 *    DEFAULT_STAGE_BUFFER_LIMIT / DEFAULT_RETRIEVAL_BUFFER_LIMIT cap the COUNT
 *    of buffered turns/stage-events/retrieval-events (last-N), NOT the content
 *    within any item. → (b) storage cap, surfaced in the Loom Timeline tab
 *    ("live buffer keeps last N …").
 * 5. Persistence (persistence/sessions/turn-records.ts): validates and stores
 *    the snapshot in full. → not a truncation point.
 * 6. Admin API assembly (buildPromptLoomData / buildTurnData below): full
 *    clones via cloneUnknownValue. → not a truncation point.
 * 7. Admin-ui event merge (admin-ui/src/lib/events/prompt-monitor.ts): full
 *    clone incl. tool input schemas + section provenance. → not a truncation.
 * 8. Svelte rendering:
 *    - PromptMonitorTextBlock / MessageList / ToolList use `overflow-auto`
 *      scroll panes (max-height) — the full content is in the DOM and
 *      scrollable. → (a) display cap, non-destructive.
 *    - `truncateValue(...)` shortens IDs/purpose strings for chrome; marks
 *      shortened values with their original length. → (a) display cap, marked.
 *
 * Conclusion: no silent content truncation exists between the assembled prompt
 * and the Loom. The historical "looked truncated" Provider Wire view is
 * classification (c) — the real session-budgeted context (compaction / history
 * span) — now labelled in the Provider Wire tab. See the DM/group fixture test
 * in session-turn-observability.test.ts.
 */
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

/**
 * Prompt-string fields for records that predate the PromptPlan snapshot
 * (E2.2). Historical persisted turn records stored these strings on
 * promptContext; current records carry the plan and the strings are derived
 * from it. This shape exists ONLY to keep historical turns viewable.
 */
interface HistoricalPromptContextRecordFields {
  renderedStaticPrefix?: string;
  renderedDynamicSuffix?: string;
  runtimeContext?: string;
  memoryContextBlock?: string;
  scratchpadContext?: string;
  assembledPrompt?: string;
  finalSystemPrompt?: string;
  messages?: ContextMessage[];
}

interface PromptLoomPromptStrings {
  renderedStaticPrefix: string | null;
  renderedDynamicSuffix: string | null;
  runtimeContext: string | null;
  memoryContextBlock: string | null;
  scratchpadContext: string | null;
  assembledPrompt: string | null;
  finalSystemPrompt: string | null;
  contextMessages: ContextMessage[];
}

function derivePromptLoomPromptStrings(
  snapshot: AdminTurnSnapshotData | null,
): PromptLoomPromptStrings {
  const plan = snapshot?.plan;
  if (plan) {
    // The persisted snapshot IS the plan: every prompt string the Loom shows
    // is derived from the same ordered blocks that shipped to the provider.
    return {
      renderedStaticPrefix: getPromptPlanBlockText(plan, 'static_prefix'),
      renderedDynamicSuffix: getPromptPlanBlockText(plan, 'dynamic_suffix'),
      runtimeContext: getPromptPlanBlockText(plan, 'runtime.context'),
      memoryContextBlock: getPromptPlanBlockText(plan, 'memory.retrieval'),
      scratchpadContext: getPromptPlanBlockText(plan, 'runtime.scratchpad'),
      assembledPrompt: renderPromptPlanAssembledPrompt(plan),
      finalSystemPrompt: serializePromptPlanSystemPrompt(plan),
      contextMessages: plan.messages.map(message => cloneUnknownValue(message)),
    };
  }
  const historical = (snapshot?.promptContext ?? null) as HistoricalPromptContextRecordFields | null;
  return {
    renderedStaticPrefix: historical?.renderedStaticPrefix ?? null,
    renderedDynamicSuffix: historical?.renderedDynamicSuffix ?? null,
    runtimeContext: historical?.runtimeContext ?? null,
    memoryContextBlock: historical?.memoryContextBlock ?? null,
    scratchpadContext: historical?.scratchpadContext ?? null,
    assembledPrompt: historical?.assembledPrompt ?? null,
    finalSystemPrompt: historical?.finalSystemPrompt ?? null,
    contextMessages: historical?.messages?.map(message => cloneUnknownValue(message)) ?? [],
  };
}

/**
 * Provider Wire projection (E2.3). For plan-backed turns the wire view is the
 * pure serialization OF the persisted plan (serializePromptPlanForProvider),
 * so the tab content is byte-equal to what shipped by construction. Legacy
 * pre-plan records (and the never-expected plan-without-transport case) fall
 * back to the recorded provider-wire capture with an explicit source marker.
 */
function buildProviderWireData(
  snapshot: AdminTurnSnapshotData | null,
  legacyFinalSystemPrompt: string | null,
): AdminPromptLoomProviderWireData {
  const plan = snapshot?.plan ?? null;
  const transport = snapshot?.promptContext?.providerObservability?.systemRole.transport ?? null;
  if (plan && transport) {
    const payload = serializePromptPlanForProvider(plan, transport);
    return {
      source: 'prompt_plan',
      legacy: false,
      systemRoleTransport: transport,
      systemPrompt: payload.systemPrompt,
      messages: payload.providerWireMessages.map(message => ({ ...message })),
      toolDefinitions: plan.toolDefinitions.map(tool => cloneUnknownValue(tool)),
    };
  }
  return {
    source: 'recorded_snapshot',
    legacy: plan === null,
    systemRoleTransport: transport,
    systemPrompt: legacyFinalSystemPrompt,
    messages: cloneProviderMessages(snapshot),
    toolDefinitions: cloneActiveTools(snapshot),
  };
}

function buildPromptLoomData(
  record: TurnRecord,
  snapshot: AdminTurnSnapshotData | null,
): AdminPromptLoomData {
  const promptContext = snapshot?.promptContext;
  const response = promptContext?.response ?? null;
  const renderedChatOutput = response?.content ?? record.assistantMessage?.content ?? null;
  const historicalHits = collectHistoricalSnapshotHits(snapshot);
  const promptStrings = derivePromptLoomPromptStrings(snapshot);
  return {
    source: 'turn_snapshot',
    snapshotCapturedAt: snapshot?.capturedAt ?? null,
    plan: snapshot?.plan ? cloneUnknownValue(snapshot.plan) : null,
    providerWire: buildProviderWireData(snapshot, promptStrings.finalSystemPrompt),
    historicalSnapshot: {
      label: HISTORICAL_SNAPSHOT_LABEL,
      removedPromptLayerIds: [...new Set(historicalHits.map(hit => hit.layerId))],
      hits: historicalHits,
    },
    generatedPrompt: {
      renderedStaticPrefix: promptStrings.renderedStaticPrefix,
      renderedDynamicSuffix: promptStrings.renderedDynamicSuffix,
      runtimeContext: promptStrings.runtimeContext,
      memoryContextBlock: promptStrings.memoryContextBlock,
      scratchpadContext: promptStrings.scratchpadContext,
      assembledPrompt: promptStrings.assembledPrompt,
      contextMessages: promptStrings.contextMessages,
      inputSections: clonePromptSections(promptContext?.inputSections),
      runtimeContextSections: clonePromptSections(promptContext?.runtimeContextSections),
      memoryContextSections: clonePromptSections(promptContext?.memoryContextSections),
      finalSystemSections: clonePromptSections(promptContext?.finalSystemSections),
    },
    providerPayload: {
      finalSystemPrompt: promptStrings.finalSystemPrompt,
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
