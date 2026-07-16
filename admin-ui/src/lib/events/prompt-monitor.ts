import type {
  AdminAuthenticityProvenance,
  AdminPromptLoomData,
  AdminPromptPlanBlock,
  AdminPromptPlanData,
  AdminPromptSectionTelemetry,
  AdminSessionTurnData,
  AdminTurnPromptContextMessage,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from '../types';
import type { GardenEventEnvelope } from './envelope';
import {
  parsePersistedTurnSnapshot,
  parsePersistedTurnSnapshotEventData,
} from './turn-snapshot-parser';
import { projectTurnSnapshotPrompt } from '../../../../src/shared/contracts/prompt-projection.js';

export const PROMPT_MONITOR_STAGE_ORDER = [
  'trust',
  'memory',
  'context',
  'first-token',
  'prompt',
  'end',
] as const;

export type PromptMonitorStageName = typeof PROMPT_MONITOR_STAGE_ORDER[number];

export interface PromptMonitorTurn {
  turnId: string;
  requestId?: string;
  channelId: string;
  latestEventAt: number;
  record: AdminSessionTurnData['record'] | null;
  snapshot: AdminTurnSnapshotData | null;
  promptLoom: AdminPromptLoomData | null;
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
}

export interface PromptMonitorSnapshotRejection {
  source: 'replay' | 'live';
  message: string;
  turnId?: string;
}

export interface PromptMonitorIngestionOptions {
  onRejectedSnapshot?: (rejection: PromptMonitorSnapshotRejection) => void;
}

export interface PromptMonitorMetrics {
  promptDurationMs: number | null;
  ttftMs: number | null;
  firstTokenSource: string | null;
  promptMode: string | null;
  contextMessages: number | null;
  systemPromptChars: number | null;
  systemPromptTokens: number | null;
  assembledPromptChars: number | null;
  assembledPromptTokens: number | null;
  memoryChars: number | null;
  totalElapsedMs: number | null;
  promptVersionPointer: string | null;
  staticHash: string | null;
  latestStage: PromptMonitorStageName | null;
  isComplete: boolean;
}

export interface PromptMonitorSummary {
  turnCount: number;
  liveTurnCount: number;
  averagePromptDurationMs: number | null;
  averageTtftMs: number | null;
  latestPromptVersionPointer: string | null;
  latestStaticHash: string | null;
}

function cloneStage(stage: AdminTurnStageTelemetry): AdminTurnStageTelemetry {
  return {
    ...stage,
    data: cloneJsonObject(stage.data),
  };
}

function cloneRetrieval(retrieval: AdminTurnRetrievalTelemetry): AdminTurnRetrievalTelemetry {
  return {
    ...retrieval,
    data: cloneJsonObject(retrieval.data),
  };
}

function cloneJsonSafe<T>(value: T): T {
  return cloneJsonSafeValue(value, new WeakSet<object>()) as T;
}

function cloneJsonObject<T extends Record<string, unknown>>(value: T): T {
  return cloneJsonSafe(value);
}

function cloneJsonSafeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(item => {
      const cloned = cloneJsonSafeValue(item, seen);
      return cloned === undefined ? null : cloned;
    });
  }

  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();

  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Window]' || tag === '[object global]') {
    return '[Unserializable global object]';
  }

  const output: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return `[Unserializable ${tag}]`;
  }

  for (const [key, nested] of entries) {
    const cloned = cloneJsonSafeValue(nested, seen);
    if (cloned !== undefined) {
      output[key] = cloned;
    }
  }
  seen.delete(value);
  return output;
}

function cloneProvenance(
  provenance: AdminAuthenticityProvenance | undefined,
): AdminAuthenticityProvenance | undefined {
  if (!provenance) return undefined;
  return {
    ...provenance,
    ...(provenance.sourceEntryIds ? { sourceEntryIds: [...provenance.sourceEntryIds] } : {}),
    ...(provenance.notes ? { notes: [...provenance.notes] } : {}),
  };
}

function clonePromptContextMessage(
  message: AdminTurnPromptContextMessage,
): AdminTurnPromptContextMessage {
  return {
    ...message,
    ...(message.provenance ? { provenance: cloneProvenance(message.provenance) } : {}),
  };
}

function clonePromptSection(
  section: AdminPromptSectionTelemetry,
): AdminPromptSectionTelemetry {
  return {
    ...section,
    ...(section.provenance ? { provenance: cloneProvenance(section.provenance) } : {}),
    ...(section.scopeProvenance ? { scopeProvenance: { ...section.scopeProvenance } } : {}),
  };
}

function clonePromptLoom(loom: AdminPromptLoomData): AdminPromptLoomData {
  return cloneJsonSafe(loom);
}

function cloneSnapshot(snapshot: AdminTurnSnapshotData): AdminTurnSnapshotData {
  const { promptContext, toolContext, ...snapshotFields } = snapshot;
  return {
    ...snapshotFields,
    ...(snapshot.prompt ? { prompt: { ...snapshot.prompt } } : {}),
    ...(snapshot.plan ? { plan: cloneJsonSafe(snapshot.plan) } : {}),
    ...(promptContext
      ? {
        promptContext: {
          ...promptContext,
          ...(promptContext.messages
            ? { messages: promptContext.messages.map(clonePromptContextMessage) }
            : {}),
          ...(promptContext.inputSections
            ? {
              inputSections: promptContext.inputSections.map(clonePromptSection),
            }
            : {}),
          ...(promptContext.runtimeContextSections
            ? {
              runtimeContextSections: promptContext.runtimeContextSections.map(clonePromptSection),
            }
            : {}),
          ...(promptContext.memoryContextSections
            ? {
              memoryContextSections: promptContext.memoryContextSections.map(clonePromptSection),
            }
            : {}),
          ...(promptContext.finalSystemSections
            ? {
              finalSystemSections: promptContext.finalSystemSections.map(clonePromptSection),
            }
            : {}),
          ...(promptContext.providerObservability
            ? {
              providerObservability: {
                ...promptContext.providerObservability,
                systemRole: { ...promptContext.providerObservability.systemRole },
                ...(promptContext.providerObservability.providerWireMessages !== undefined
                  ? {
                    providerWireMessages: promptContext.providerObservability.providerWireMessages
                      .map(message => ({ ...message })),
                  }
                  : {}),
              },
            }
            : {}),
          ...(promptContext.response
            ? {
              response: {
                ...promptContext.response,
              },
            }
            : {}),
        },
      }
      : {}),
    ...(toolContext
      ? {
        toolContext: {
          ...(toolContext.activeTools !== undefined
            ? {
              activeTools: toolContext.activeTools.map(tool => ({
                ...tool,
                inputSchema: cloneJsonObject(tool.inputSchema),
              })),
            }
            : {}),
          ...(toolContext.adaptiveSnapshot
            ? {
              adaptiveSnapshot: {
                ...toolContext.adaptiveSnapshot,
                tools: toolContext.adaptiveSnapshot.tools.map(tool => ({ ...tool })),
                skipped: toolContext.adaptiveSnapshot.skipped.map(skip => ({
                  ...skip,
                  ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
                })),
                counts: { ...toolContext.adaptiveSnapshot.counts },
              },
            }
            : {}),
        },
      }
      : {}),
    ...(snapshot.sessionContext
      ? {
        sessionContext: {
          ...snapshot.sessionContext,
          recentEntries: [...snapshot.sessionContext.recentEntries],
          compactionSummaryTexts: [...snapshot.sessionContext.compactionSummaryTexts],
          focusKnowledgeTexts: [...snapshot.sessionContext.focusKnowledgeTexts],
          continuityEntries: [...snapshot.sessionContext.continuityEntries],
        },
      }
      : {}),
    ...(snapshot.memory
      ? {
        memory: {
          ...snapshot.memory,
          contactEmotionalMemories: [...snapshot.memory.contactEmotionalMemories],
          semanticCandidates: [...snapshot.memory.semanticCandidates],
          lexicalCandidates: [...snapshot.memory.lexicalCandidates],
          proactiveCandidates: [...snapshot.memory.proactiveCandidates],
          ...(snapshot.memory.withheldSummary
            ? {
              withheldSummary: {
                ...snapshot.memory.withheldSummary,
                reasonCounts: { ...snapshot.memory.withheldSummary.reasonCounts },
              },
            }
            : {}),
        },
      }
      : {}),
  };
}

function stageOrderIndex(stage: string): number {
  const index = PROMPT_MONITOR_STAGE_ORDER.indexOf(stage as PromptMonitorStageName);
  return index >= 0 ? index : PROMPT_MONITOR_STAGE_ORDER.length;
}

function sortStages(stages: readonly AdminTurnStageTelemetry[]): AdminTurnStageTelemetry[] {
  return [...stages]
    .sort((left, right) => {
      const leftOrder = stageOrderIndex(left.stage);
      const rightOrder = stageOrderIndex(right.stage);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.observedAt - right.observedAt;
    })
    .map(cloneStage);
}

function sortTurns(turns: readonly PromptMonitorTurn[]): PromptMonitorTurn[] {
  return [...turns]
    .sort((left, right) => {
      if (right.latestEventAt !== left.latestEventAt) {
        return right.latestEventAt - left.latestEventAt;
      }
      return right.turnId.localeCompare(left.turnId);
    })
    .map(turn => ({
      ...turn,
      stages: sortStages(turn.stages),
      retrievals: turn.retrievals.map(cloneRetrieval),
      snapshot: turn.snapshot ? cloneSnapshot(turn.snapshot) : null,
      promptLoom: turn.promptLoom ? clonePromptLoom(turn.promptLoom) : null,
    }));
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function findStage(
  turn: PromptMonitorTurn,
  stageName: PromptMonitorStageName,
): AdminTurnStageTelemetry | null {
  return turn.stages.find(stage => stage.stage === stageName) ?? null;
}

function reportRejectedSnapshot(
  options: PromptMonitorIngestionOptions,
  rejection: PromptMonitorSnapshotRejection,
): void {
  try {
    if (options.onRejectedSnapshot) {
      options.onRejectedSnapshot(rejection);
      return;
    }
    console.error('Prompt monitor rejected malformed turn snapshot', rejection);
  } catch (cause) {
    console.error('Prompt monitor snapshot rejection reporter failed', cause, rejection);
  }
}

function parseReplaySnapshot(
  turn: AdminSessionTurnData,
  options: PromptMonitorIngestionOptions,
): AdminTurnSnapshotData | null {
  if (turn.snapshot === null) return null;
  const parsed = parsePersistedTurnSnapshot(turn.snapshot);
  if (!parsed.ok) {
    reportRejectedSnapshot(options, {
      source: 'replay',
      message: parsed.error,
      turnId: turn.record.turnId,
    });
    return null;
  }
  if (
    parsed.value.turnId !== turn.record.turnId
    || parsed.value.requestId !== turn.record.requestId
    || parsed.value.channelId !== turn.record.channelId
  ) {
    reportRejectedSnapshot(options, {
      source: 'replay',
      message: 'snapshot identity does not match its persisted turn record',
      turnId: turn.record.turnId,
    });
    return null;
  }
  return parsed.value;
}

function buildTurnFromSession(
  turn: AdminSessionTurnData,
  options: PromptMonitorIngestionOptions,
): PromptMonitorTurn {
  const snapshot = parseReplaySnapshot(turn, options);
  const latestStageAt = turn.stages.reduce(
    (latest, stage) => Math.max(latest, stage.observedAt),
    0,
  );
  const latestEventAt = Math.max(
    turn.record.completedAt,
    snapshot?.capturedAt ?? 0,
    latestStageAt,
  );

  return {
    turnId: turn.record.turnId,
    requestId: turn.record.requestId,
    channelId: turn.record.channelId,
    latestEventAt,
    record: { ...turn.record },
    snapshot,
    promptLoom: turn.promptLoom ? clonePromptLoom(turn.promptLoom) : null,
    stages: sortStages(turn.stages),
    retrievals: turn.retrievals.map(cloneRetrieval),
  };
}

const HISTORICAL_SNAPSHOT_LABEL = 'Persisted turn snapshot; not current prompt generator state.';
const REMOVED_PROMPT_LAYER_IDS = [
  'runtime_self',
  'model_context',
  'analysis_workbench_guidance',
] as const;

function historicalLayerMatches(text: string | null | undefined, layerId: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return normalized.includes(layerId) || normalized.includes(layerId.replaceAll('_', ' '));
}

function addHistoricalHitsForText(
  hits: AdminPromptLoomData['historicalSnapshot']['hits'],
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
  hits: AdminPromptLoomData['historicalSnapshot']['hits'],
  source: string,
  sections: AdminPromptSectionTelemetry[] | undefined,
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
): AdminPromptLoomData['historicalSnapshot']['hits'] {
  const hits: AdminPromptLoomData['historicalSnapshot']['hits'] = [];
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

function hasToolResultPayload(toolCall: AdminSessionTurnData['record']['toolCalls'][number]): boolean {
  const record = toolCall as unknown as Record<string, unknown>;
  return typeof record.resultText === 'string'
    || typeof record.isError === 'boolean'
    || record.details !== undefined;
}

function clonePromptSectionsForLoom(
  sections: AdminPromptSectionTelemetry[] | undefined,
): AdminPromptLoomData['generatedPrompt']['inputSections'] {
  return (sections?.map(clonePromptSection) ?? []) as AdminPromptLoomData['generatedPrompt']['inputSections'];
}

function buildPromptLoomFromTurn(turn: PromptMonitorTurn): AdminPromptLoomData {
  const snapshot = turn.snapshot;
  const promptContext = snapshot?.promptContext;
  const projection = projectTurnSnapshotPrompt(snapshot);
  const planStrings = projection.strings;
  const response = promptContext?.response ?? null;
  const renderedChatOutput = response?.content ?? turn.record?.assistantMessage?.content ?? null;
  const historicalHits = collectHistoricalSnapshotHits(snapshot);
  const toolCalls = turn.record?.toolCalls ?? [];
  return {
    source: 'turn_snapshot',
    snapshotCapturedAt: snapshot?.capturedAt ?? null,
    plan: (snapshot?.plan ? cloneJsonSafe(snapshot.plan) : null) as AdminPromptLoomData['plan'],
    providerWire: projection.providerWire,
    historicalSnapshot: {
      label: HISTORICAL_SNAPSHOT_LABEL,
      removedPromptLayerIds: [...new Set(historicalHits.map(hit => hit.layerId))],
      hits: historicalHits,
    },
    generatedPrompt: {
      renderedStaticPrefix: planStrings.renderedStaticPrefix,
      renderedDynamicSuffix: planStrings.renderedDynamicSuffix,
      runtimeContext: planStrings.runtimeContext,
      memoryContextBlock: planStrings.memoryContextBlock,
      scratchpadContext: planStrings.scratchpadContext,
      assembledPrompt: planStrings.assembledPrompt,
      contextMessages: planStrings.contextMessages,
      inputSections: clonePromptSectionsForLoom(promptContext?.inputSections),
      runtimeContextSections: clonePromptSectionsForLoom(promptContext?.runtimeContextSections),
      memoryContextSections: clonePromptSectionsForLoom(promptContext?.memoryContextSections),
      finalSystemSections: clonePromptSectionsForLoom(promptContext?.finalSystemSections),
    },
    providerPayload: {
      finalSystemPrompt: planStrings.finalSystemPrompt,
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
        ...(turn.record?.userMessage ? { userMessage: { ...turn.record.userMessage } } : {}),
        ...(turn.record?.assistantMessage ? { assistantMessage: { ...turn.record.assistantMessage } } : {}),
        renderedChatOutput,
      },
      output: {
        extractedMemoryIds: [...(turn.record?.extractedMemoryIds ?? [])],
      },
    },
    subsystemOutputs: {
      projectionStatus: (turn.record?.extractedMemoryIds.length ?? 0)
        + (turn.record?.concernDeltaRefs.length ?? 0)
        + (turn.record?.contactDeltaRefs.length ?? 0) > 0
        ? 'pending'
        : 'not_applicable',
      contextManifestRef: turn.record?.contextManifestRef ?? null,
      internalStateSnapshotRef: turn.record?.internalStateSnapshotRef ?? null,
      memoryWrites: (turn.record?.extractedMemoryIds ?? []).map(ref => ({
        ref,
        status: 'not_resolved',
      })),
      concernDeltas: (turn.record?.concernDeltaRefs ?? []).map(ref => ({
        ref,
        status: 'not_resolved',
      })),
      contactDeltas: (turn.record?.contactDeltaRefs ?? []).map(ref => ({
        ref,
        status: 'not_resolved',
      })),
    },
    toolActivity: {
      toolCalls: toolCalls.map(toolCall => cloneJsonSafe(toolCall)),
      toolResults: toolCalls
        .filter(hasToolResultPayload)
        .map(toolCall => cloneJsonSafe(toolCall)),
    },
  };
}

export function resolvePromptMonitorPromptLoom(turn: PromptMonitorTurn): AdminPromptLoomData {
  return turn.promptLoom ? clonePromptLoom(turn.promptLoom) : buildPromptLoomFromTurn(turn);
}

/**
 * The turn's PromptPlan as the Loom projects it: prefer the API-served loom
 * plan, fall back to the live-bus snapshot plan. null → legacy pre-plan turn.
 */
export function resolvePromptMonitorPlan(turn: PromptMonitorTurn): AdminPromptPlanData | null {
  const plan = turn.promptLoom?.plan ?? turn.snapshot?.plan ?? null;
  return plan ? (cloneJsonSafe(plan) as AdminPromptPlanData) : null;
}

// ── Turn-diff affordance (E2.3): block-level diff between two plans ──

export type PromptPlanBlockDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface PromptPlanBlockDiffEntry {
  id: string;
  status: PromptPlanBlockDiffStatus;
  layer: AdminPromptPlanBlock['layer'] | null;
  volatility: AdminPromptPlanBlock['volatility'] | null;
  producer: string | null;
  scopeKey: string | null;
  /** UTF-8 byte sizes of the rendered block text (changed-bytes indicator). */
  bytesBefore: number | null;
  bytesAfter: number | null;
  bytesDelta: number | null;
}

export interface PromptPlanBlockDiff {
  /** false when either side lacks a plan (legacy pre-plan turn). */
  comparable: boolean;
  entries: PromptPlanBlockDiffEntry[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
  /** Non-unchanged blocks whose volatility is 'static' (should be 0 for a quiet consecutive pair). */
  staticRegionChangedCount: number;
}

const PLAN_TEXT_ENCODER = new TextEncoder();

function planBlockBytes(block: AdminPromptPlanBlock): number {
  return PLAN_TEXT_ENCODER.encode(block.renderedText).length;
}

/**
 * Block-level diff between two turns' plans: which blocks appeared,
 * disappeared, or changed (id-level identity, byte-size indicator per block).
 * Entries follow the after-plan block order; removed blocks are appended in
 * their before-plan order.
 */
export function diffPromptPlanBlocks(
  before: AdminPromptPlanData | null | undefined,
  after: AdminPromptPlanData | null | undefined,
): PromptPlanBlockDiff {
  if (!before || !after) {
    return {
      comparable: false,
      entries: [],
      addedCount: 0,
      removedCount: 0,
      changedCount: 0,
      unchangedCount: 0,
      staticRegionChangedCount: 0,
    };
  }
  const beforeById = new Map(before.blocks.map(block => [block.id, block]));
  const afterIds = new Set(after.blocks.map(block => block.id));
  const entries: PromptPlanBlockDiffEntry[] = [];

  for (const afterBlock of after.blocks) {
    const beforeBlock = beforeById.get(afterBlock.id);
    if (!beforeBlock) {
      entries.push({
        id: afterBlock.id,
        status: 'added',
        layer: afterBlock.layer,
        volatility: afterBlock.volatility,
        producer: afterBlock.producer,
        scopeKey: afterBlock.scopeKey ?? null,
        bytesBefore: null,
        bytesAfter: planBlockBytes(afterBlock),
        bytesDelta: null,
      });
      continue;
    }
    const bytesBefore = planBlockBytes(beforeBlock);
    const bytesAfter = planBlockBytes(afterBlock);
    entries.push({
      id: afterBlock.id,
      status: beforeBlock.renderedText === afterBlock.renderedText ? 'unchanged' : 'changed',
      layer: afterBlock.layer,
      volatility: afterBlock.volatility,
      producer: afterBlock.producer,
      scopeKey: afterBlock.scopeKey ?? null,
      bytesBefore,
      bytesAfter,
      bytesDelta: bytesAfter - bytesBefore,
    });
  }
  for (const beforeBlock of before.blocks) {
    if (afterIds.has(beforeBlock.id)) continue;
    entries.push({
      id: beforeBlock.id,
      status: 'removed',
      layer: beforeBlock.layer,
      volatility: beforeBlock.volatility,
      producer: beforeBlock.producer,
      scopeKey: beforeBlock.scopeKey ?? null,
      bytesBefore: planBlockBytes(beforeBlock),
      bytesAfter: null,
      bytesDelta: null,
    });
  }

  return {
    comparable: true,
    entries,
    addedCount: entries.filter(entry => entry.status === 'added').length,
    removedCount: entries.filter(entry => entry.status === 'removed').length,
    changedCount: entries.filter(entry => entry.status === 'changed').length,
    unchangedCount: entries.filter(entry => entry.status === 'unchanged').length,
    staticRegionChangedCount: entries.filter(
      entry => entry.volatility === 'static' && entry.status !== 'unchanged',
    ).length,
  };
}

// ── Cache projection: static-prefix hash timeline across recent turns ──

export interface PromptMonitorStaticHashTimelineEntry {
  turnId: string;
  latestEventAt: number;
  staticHash: string | null;
  /** null when this or every earlier turn lacks a recorded hash. */
  changedFromPrevious: boolean | null;
}

export function buildStaticPrefixHashTimeline(
  turns: readonly PromptMonitorTurn[],
  limit: number = 12,
): PromptMonitorStaticHashTimelineEntry[] {
  const ascending = [...turns]
    .sort((left, right) => left.latestEventAt - right.latestEventAt)
    .slice(-Math.max(1, limit));
  let previousHash: string | null = null;
  return ascending.map(turn => {
    const staticHash = readString(turn.snapshot?.prompt?.staticHash);
    const changedFromPrevious = staticHash !== null && previousHash !== null
      ? staticHash !== previousHash
      : null;
    if (staticHash !== null) {
      previousHash = staticHash;
    }
    return {
      turnId: turn.turnId,
      latestEventAt: turn.latestEventAt,
      staticHash,
      changedFromPrevious,
    };
  });
}

function readSnapshotEnvelopeData(
  event: GardenEventEnvelope,
  options: PromptMonitorIngestionOptions,
): AdminTurnSnapshotData | null {
  if (event.type !== 'agent.turn.snapshot') return null;
  const parsed = parsePersistedTurnSnapshotEventData(event.data);
  if (!parsed.ok) {
    reportRejectedSnapshot(options, {
      source: 'live',
      message: parsed.error,
      ...(event.correlation.turnId ? { turnId: event.correlation.turnId } : {}),
    });
    return null;
  }
  if (
    (event.correlation.turnId && event.correlation.turnId !== parsed.value.turnId)
    || (event.correlation.requestId && event.correlation.requestId !== parsed.value.requestId)
    || (event.correlation.channelId && event.correlation.channelId !== parsed.value.channelId)
  ) {
    reportRejectedSnapshot(options, {
      source: 'live',
      message: 'snapshot identity does not match its WebSocket event correlation',
      ...(event.correlation.turnId ? { turnId: event.correlation.turnId } : {}),
    });
    return null;
  }
  return parsed.value;
}

function readStageEnvelopeData(
  event: GardenEventEnvelope,
): AdminTurnStageTelemetry | null {
  if (event.type !== 'agent.turn.stage' || typeof event.data !== 'object' || event.data === null) {
    return null;
  }
  const stage = event.data as AdminTurnStageTelemetry;
  if (
    typeof stage.turnId !== 'string'
    || typeof stage.channelId !== 'string'
    || typeof stage.stage !== 'string'
  ) {
    return null;
  }
  return cloneStage(stage);
}

function readRetrievalEnvelopeData(event: GardenEventEnvelope): AdminTurnRetrievalTelemetry | null {
  if (event.type !== 'memory.retrieval' || typeof event.data !== 'object' || event.data === null) {
    return null;
  }
  const retrieval = event.data as AdminTurnRetrievalTelemetry;
  if (
    typeof retrieval.turnId !== 'string'
    || retrieval.turnId.trim().length === 0
    || typeof retrieval.channelId !== 'string'
    || retrieval.channelId.trim().length === 0
    || typeof retrieval.observedAt !== 'number'
    || !Number.isFinite(retrieval.observedAt)
    || typeof retrieval.count !== 'number'
    || !Number.isFinite(retrieval.count)
    || typeof retrieval.data !== 'object'
    || retrieval.data === null
    || Array.isArray(retrieval.data)
  ) {
    return null;
  }
  return cloneRetrieval(retrieval);
}

export function buildPromptMonitorTurns(
  turns: readonly AdminSessionTurnData[],
  options: PromptMonitorIngestionOptions = {},
): PromptMonitorTurn[] {
  return sortTurns(turns.map(turn => buildTurnFromSession(turn, options)));
}

export function mergePromptMonitorEvent(
  turns: readonly PromptMonitorTurn[],
  event: GardenEventEnvelope,
  options: PromptMonitorIngestionOptions = {},
): PromptMonitorTurn[] {
  const snapshot = readSnapshotEnvelopeData(event, options);
  const stage = readStageEnvelopeData(event);
  const retrieval = readRetrievalEnvelopeData(event);
  if (!snapshot && !stage && !retrieval) {
    return [...turns];
  }

  const turnId = snapshot?.turnId ?? stage?.turnId ?? retrieval?.turnId;
  const channelId = snapshot?.channelId ?? stage?.channelId ?? retrieval?.channelId;
  if (!turnId || !channelId) {
    return [...turns];
  }

  const existing = turns.find(candidate => candidate.turnId === turnId);
  const nextTurn: PromptMonitorTurn = existing
    ? {
      ...existing,
      latestEventAt: Math.max(existing.latestEventAt, event.timestamp),
      snapshot: snapshot ?? existing.snapshot,
      stages: stage
        ? sortStages([
          ...existing.stages.filter(candidate => candidate.stage !== stage.stage),
          stage,
        ])
        : sortStages(existing.stages),
      retrievals: retrieval
        ? [...existing.retrievals, retrieval].map(cloneRetrieval)
        : existing.retrievals.map(cloneRetrieval),
    }
    : {
      turnId,
      requestId: snapshot?.requestId ?? stage?.requestId,
      channelId,
      latestEventAt: event.timestamp,
      record: null,
      snapshot: snapshot,
      promptLoom: null,
      stages: stage ? [stage] : [],
      retrievals: retrieval ? [retrieval] : [],
    };

  const remaining = turns.filter(candidate => candidate.turnId !== turnId);
  return sortTurns([nextTurn, ...remaining]);
}

/**
 * Replace a live-bus projection with the canonical backend-resolved turn.
 * The lazy turn-detail API uses the same resolver as session history, so after
 * this merge slim live records and API-fetched records share one render path.
 */
export function mergePromptMonitorResolvedTurn(
  turns: readonly PromptMonitorTurn[],
  resolvedTurn: AdminSessionTurnData,
  options: PromptMonitorIngestionOptions = {},
): PromptMonitorTurn[] {
  const resolved = buildTurnFromSession(resolvedTurn, options);
  return sortTurns([
    resolved,
    ...turns.filter(turn => turn.turnId !== resolved.turnId),
  ]);
}

export function formatPromptMonitorStageLabel(stage: string): string {
  if (stage === 'first-token') return 'First Token';
  if (!stage) return 'Unknown';
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export function resolvePromptMonitorMetrics(turn: PromptMonitorTurn): PromptMonitorMetrics {
  const promptStage = findStage(turn, 'prompt');
  const firstTokenStage = findStage(turn, 'first-token');
  const contextStage = findStage(turn, 'context');
  const memoryStage = findStage(turn, 'memory');
  const endStage = findStage(turn, 'end');
  const latestStage = turn.stages.at(-1)?.stage ?? null;

  return {
    promptDurationMs: promptStage ? promptStage.elapsedMs : null,
    ttftMs: readNumber(promptStage?.data.ttftMs) ?? readNumber(firstTokenStage?.data.ttftMs),
    firstTokenSource: readString(firstTokenStage?.data.source),
    promptMode: readString(promptStage?.data.mode)
      ?? readString(promptStage?.data.promptMode)
      ?? readString(turn.record?.versionPointers.promptMode),
    contextMessages: readNumber(contextStage?.data.contextMessages),
    systemPromptChars: readNumber(contextStage?.data.systemPromptChars),
    systemPromptTokens: readNumber(contextStage?.data.systemPromptTokens),
    assembledPromptChars: readNumber(contextStage?.data.assembledPromptChars),
    assembledPromptTokens: readNumber(contextStage?.data.assembledPromptTokens),
    memoryChars: readNumber(memoryStage?.data.memoryChars),
    totalElapsedMs: endStage ? endStage.elapsedMs : null,
    promptVersionPointer: readString(turn.snapshot?.prompt?.versionPointer)
      ?? readString(turn.record?.versionPointers.promptStack),
    staticHash: readString(turn.snapshot?.prompt?.staticHash),
    latestStage: latestStage as PromptMonitorStageName | null,
    isComplete: endStage != null || turn.record?.status === 'completed',
  };
}

export function resolvePromptMonitorSummary(
  turns: readonly PromptMonitorTurn[],
): PromptMonitorSummary {
  const metrics = turns.map(resolvePromptMonitorMetrics);
  const promptDurations = metrics
    .map(metric => metric.promptDurationMs)
    .filter((value): value is number => value != null);
  const ttftValues = metrics
    .map(metric => metric.ttftMs)
    .filter((value): value is number => value != null);
  const latestMetrics = metrics[0] ?? null;

  return {
    turnCount: turns.length,
    liveTurnCount: metrics.filter(metric => !metric.isComplete).length,
    averagePromptDurationMs: promptDurations.length > 0
      ? promptDurations.reduce((sum, value) => sum + value, 0) / promptDurations.length
      : null,
    averageTtftMs: ttftValues.length > 0
      ? ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length
      : null,
    latestPromptVersionPointer: latestMetrics?.promptVersionPointer ?? null,
    latestStaticHash: latestMetrics?.staticHash ?? null,
  };
}
