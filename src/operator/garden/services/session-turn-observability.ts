import type { EventBus } from '../../../shared/event-bus.js';
import {
  cloneUnknownValue,
  cloneTurnRetrievalTelemetryRecord,
  cloneTurnSnapshotRecord,
  cloneTurnStageTelemetryRecord,
  sanitizeObservedMemory,
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../../core/turns/observability.js';
import type {
  AdminContinuityProvenanceView,
  AdminPromptLoomData,
  AdminPromptLoomContactOutputData,
  AdminPromptLoomConcernOutputData,
  AdminPromptLoomHistoricalSnapshotHit,
  AdminPromptLoomSubsystemOutputEntry,
  AdminPromptLoomSubsystemOutputProjectionStatus,
  AdminPromptLoomSubsystemOutputsData,
  AdminSessionTurnData,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from './types.js';
import type {
  PromptSectionTelemetry,
  TurnRecord,
} from '../../../shared/contracts/runtime.js';
import { projectTurnSnapshotPrompt } from '../../../shared/contracts/prompt-projection.js';
import { countToolCallOutcomes } from '../../../shared/contracts/tool-call-outcome.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  parseSubsystemOutputRef,
  type SubsystemOutputKind,
} from '../../../shared/contracts/subsystem-output-refs.js';

/**
 * Truncation-point inventory (bead u9jo.2).
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


/**
 * Derive a Final System Sections view from the canonical plan blocks. NOTE: the
 * write-time `finalSystemSections` is a distinct SEMANTIC decomposition built by
 * the session context builder (titled sections with authenticity provenance),
 * NOT a 1:1 rendering of plan blocks — so this derived view is a best-effort
 * ordered-block projection, not a byte-faithful reconstruction. The fat-record
 * read path below always prefers the embedded copy when present.
 */
function deriveFinalSystemSectionsFromPlan(snapshot: AdminTurnSnapshotData | null): PromptSectionTelemetry[] {
  const plan = snapshot?.plan ?? null;
  if (!plan) return [];
  return plan.blocks
    .filter(block => block.renderedText.trim().length > 0)
    .map(block => ({
      id: block.id,
      title: block.id,
      content: block.renderedText,
      charCount: block.renderedText.length,
      tokenCount: block.tokensEst,
    }));
}

/**
 * FAT-RECORD READ PATH (schema tolerance): prefer the embedded
 * `finalSystemSections` verbatim; SLIM records derive the best-effort plan-block
 * projection (see `deriveFinalSystemSectionsFromPlan`).
 */
function resolveFinalSystemSections(
  snapshot: AdminTurnSnapshotData | null,
): AdminPromptLoomData['generatedPrompt']['finalSystemSections'] {
  const embedded = snapshot?.promptContext?.finalSystemSections;
  const sections = embedded ?? deriveFinalSystemSectionsFromPlan(snapshot);
  return sections.map(section => cloneUnknownValue(section));
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

function collectHistoricalSnapshotHits(
  snapshot: AdminTurnSnapshotData | null,
  finalSystemSections: AdminPromptLoomData['generatedPrompt']['finalSystemSections'],
): AdminPromptLoomHistoricalSnapshotHit[] {
  const hits: AdminPromptLoomHistoricalSnapshotHit[] = [];
  addHistoricalHitsForText(hits, 'prompt.staticPrefixTemplate', snapshot?.prompt?.staticPrefixTemplate);
  addHistoricalHitsForText(hits, 'prompt.dynamicSuffixTemplate', snapshot?.prompt?.dynamicSuffixTemplate);
  addHistoricalHitsForSections(hits, 'promptContext.inputSections', snapshot?.promptContext?.inputSections);
  addHistoricalHitsForSections(
    hits,
    'promptContext.runtimeContextSections',
    snapshot?.promptContext?.runtimeContextSections,
  );
  // Resolved sections (embedded copy for fat records, plan-block projection for
  // slim records) so the removed-layer scan works regardless of persistence.
  addHistoricalHitsForSections(
    hits,
    'promptContext.finalSystemSections',
    finalSystemSections,
  );
  return hits;
}

function hasToolResultPayload(toolCall: TurnRecord['toolCalls'][number]): boolean {
  const record = toolCall as unknown as Record<string, unknown>;
  return typeof record.resultText === 'string'
    || typeof record.isError === 'boolean'
    || record.outcome !== undefined
    || record.details !== undefined;
}

function normalizeSubsystemOutputRef(ref: string, field: string): string {
  const normalized = ref.trim();
  if (!normalized) {
    throw new Error(`${field} must contain non-empty refs`);
  }
  return normalized;
}

function buildUnresolvedOutputEntries<TValue>(
  refs: readonly string[],
  field: string,
): Array<AdminPromptLoomSubsystemOutputEntry<TValue>> {
  return refs.map(ref => ({
    ref: normalizeSubsystemOutputRef(ref, field),
    status: 'not_resolved',
  }));
}

/**
 * Live-only placeholder. The browser can render snapshot-only turns while they
 * are still in flight, but durable output refs remain explicitly unresolved
 * until the canonical turn-detail endpoint supplies the read-side projection.
 */
export function buildUnresolvedPromptLoomSubsystemOutputs(
  record: Pick<
    TurnRecord,
    | 'contextManifestRef'
    | 'internalStateSnapshotRef'
    | 'extractedMemoryIds'
    | 'concernDeltaRefs'
    | 'contactDeltaRefs'
  >,
): AdminPromptLoomSubsystemOutputsData {
  const hasProjectionRefs = record.extractedMemoryIds.length > 0
    || record.concernDeltaRefs.length > 0
    || record.contactDeltaRefs.length > 0;
  return {
    projectionStatus: hasProjectionRefs ? 'pending' : 'not_applicable',
    contextManifestRef: record.contextManifestRef ?? null,
    internalStateSnapshotRef: record.internalStateSnapshotRef ?? null,
    memoryWrites: buildUnresolvedOutputEntries(record.extractedMemoryIds, 'extractedMemoryIds'),
    concernDeltas: buildUnresolvedOutputEntries(record.concernDeltaRefs, 'concernDeltaRefs'),
    contactDeltas: buildUnresolvedOutputEntries(record.contactDeltaRefs, 'contactDeltaRefs'),
  };
}

function projectConcernOutput(concern: NonNullable<Awaited<ReturnType<ConcernStorePort['getById']>>>): AdminPromptLoomConcernOutputData {
  return {
    id: concern.id,
    text: concern.text,
    priority: concern.priority,
    source: concern.source,
    status: concern.status,
    createdAt: concern.createdAt,
    expiresAt: concern.expiresAt,
    salience: concern.salience,
    sensitivity: concern.sensitivity,
    owner: concern.owner,
    ...(concern.contactId ? { contactId: concern.contactId } : {}),
  };
}

function projectContactOutput(contact: NonNullable<Awaited<ReturnType<ContactStorePort['getById']>>>): AdminPromptLoomContactOutputData {
  return {
    id: contact.id,
    trustLevel: contact.trustLevel,
    relationshipType: contact.relationshipType,
    ...(contact.isMachineIntelligence !== undefined
      ? { isMachineIntelligence: contact.isMachineIntelligence }
      : {}),
    firstSeen: contact.firstSeen,
    lastSeen: contact.lastSeen,
  };
}

function parseTargetRef(rawRef: string, field: string, kind: SubsystemOutputKind) {
  const ref = normalizeSubsystemOutputRef(rawRef, field);
  const parsed = parseSubsystemOutputRef(ref);
  if (parsed.kind !== kind) {
    throw new Error(`Invalid ${field} subsystem output kind: ${parsed.kind}`);
  }
  return { ref, targetId: parsed.targetId };
}

function requireResolverStore<TStore>(
  refs: readonly string[],
  store: TStore | null | undefined,
  label: string,
): TStore | null {
  if (refs.length === 0) return null;
  if (!store) {
    throw new Error(`Cannot resolve turn-record ${label} refs: no ${label} store is configured`);
  }
  return store;
}

/**
 * Dereference TurnRecord subsystem-output refs at the authenticated Garden
 * read boundary. Missing/deleted targets stay content-free and visible as
 * `missing`; store failures propagate so privacy/authority errors cannot turn
 * into a silent partial response. This function never mutates the record.
 */
export async function resolvePromptLoomSubsystemOutputs(
  record: TurnRecord,
  deps: {
    memoryStore?: MemoryStorePort | null;
    concernStore?: ConcernStorePort | null;
    contactStore?: ContactStorePort | null;
    projectionStatus?: AdminPromptLoomSubsystemOutputProjectionStatus;
  },
): Promise<AdminPromptLoomSubsystemOutputsData> {
  const memoryStore = requireResolverStore(record.extractedMemoryIds, deps.memoryStore, 'memory');
  const concernStore = requireResolverStore(record.concernDeltaRefs, deps.concernStore, 'concern');
  const contactStore = requireResolverStore(record.contactDeltaRefs, deps.contactStore, 'contact');

  const [memoryWrites, concernDeltas, contactDeltas] = await Promise.all([
    Promise.all(record.extractedMemoryIds.map(async (rawRef) => {
      const { ref, targetId } = parseTargetRef(rawRef, 'extractedMemoryIds', 'memory');
      const memory = await memoryStore?.getById(targetId);
      return memory && memory.deletedAt === undefined
        ? { ref, status: 'resolved' as const, value: sanitizeObservedMemory(memory) }
        : { ref, status: 'missing' as const };
    })),
    Promise.all(record.concernDeltaRefs.map(async (rawRef) => {
      const { ref, targetId } = parseTargetRef(rawRef, 'concernDeltaRefs', 'concern');
      const concern = await concernStore?.getById(targetId);
      return concern
        ? { ref, status: 'resolved' as const, value: projectConcernOutput(concern) }
        : { ref, status: 'missing' as const };
    })),
    Promise.all(record.contactDeltaRefs.map(async (rawRef) => {
      const { ref, targetId } = parseTargetRef(rawRef, 'contactDeltaRefs', 'contact');
      const contact = await contactStore?.getById(targetId);
      return contact
        ? { ref, status: 'resolved' as const, value: projectContactOutput(contact) }
        : { ref, status: 'missing' as const };
    })),
  ]);

  return {
    projectionStatus: deps.projectionStatus
      ?? (memoryWrites.length + concernDeltas.length + contactDeltas.length > 0
        ? 'applied'
        : 'not_applicable'),
    contextManifestRef: record.contextManifestRef ?? null,
    internalStateSnapshotRef: record.internalStateSnapshotRef ?? null,
    memoryWrites,
    concernDeltas,
    contactDeltas,
  };
}

export function buildPromptLoomData(
  record: TurnRecord,
  snapshot: AdminTurnSnapshotData | null,
  subsystemOutputs: AdminPromptLoomSubsystemOutputsData = buildUnresolvedPromptLoomSubsystemOutputs(record),
): AdminPromptLoomData {
  const promptContext = snapshot?.promptContext;
  const response = promptContext?.response ?? null;
  const renderedChatOutput = response?.content ?? record.assistantMessage?.content ?? null;
  const finalSystemSections = resolveFinalSystemSections(snapshot);
  const historicalHits = collectHistoricalSnapshotHits(snapshot, finalSystemSections);
  const projection = projectTurnSnapshotPrompt(snapshot);
  const promptStrings = projection.strings;
  const toolOutcomeCounts = countToolCallOutcomes(record.toolCalls);
  return {
    source: 'turn_snapshot',
    snapshotCapturedAt: snapshot?.capturedAt ?? null,
    plan: snapshot?.plan ? cloneUnknownValue(snapshot.plan) : null,
    providerWire: projection.providerWire,
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
      finalSystemSections,
    },
    providerPayload: {
      finalSystemPrompt: promptStrings.finalSystemPrompt,
      providerMessages: projection.providerMessages,
      activeTools: projection.activeTools,
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
    subsystemOutputs: cloneUnknownValue(subsystemOutputs),
    toolActivity: {
      toolCalls: record.toolCalls.map(toolCall => cloneUnknownValue(toolCall)),
      toolResults: record.toolCalls
        .filter(hasToolResultPayload)
        .map(toolCall => cloneUnknownValue(toolCall)),
      outcomeCounts: toolOutcomeCounts,
      runtimeFailureCount: toolOutcomeCounts.execution_failure,
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

  buildTurnData(
    record: AdminSessionTurnData['record'],
    subsystemOutputs?: AdminPromptLoomSubsystemOutputsData,
  ): AdminSessionTurnData {
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
      promptLoom: buildPromptLoomData(record, snapshot, subsystemOutputs),
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
