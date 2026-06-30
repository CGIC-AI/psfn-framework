import type {
  AdminAuthenticityProvenance,
  AdminPromptLoomData,
  AdminPromptSectionTelemetry,
  AdminSessionTurnData,
  AdminTurnPromptContextMessage,
  AdminTurnProviderWireMessage,
  AdminTurnSnapshotData,
  AdminTurnStageTelemetry,
} from '../types';
import type { GardenEventEnvelope } from './envelope';

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
    data: { ...stage.data },
  };
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
  };
}

function clonePromptLoom(loom: AdminPromptLoomData): AdminPromptLoomData {
  return structuredClone(loom);
}

function cloneSnapshot(snapshot: AdminTurnSnapshotData): AdminTurnSnapshotData {
  return {
    ...snapshot,
    ...(snapshot.prompt ? { prompt: { ...snapshot.prompt } } : {}),
    ...(snapshot.promptContext
      ? {
        promptContext: {
          ...snapshot.promptContext,
          messages: snapshot.promptContext.messages.map(clonePromptContextMessage),
          ...(snapshot.promptContext.inputSections
            ? {
              inputSections: snapshot.promptContext.inputSections.map(clonePromptSection),
            }
            : {}),
          ...(snapshot.promptContext.runtimeContextSections
            ? {
              runtimeContextSections: snapshot.promptContext.runtimeContextSections.map(clonePromptSection),
            }
            : {}),
          ...(snapshot.promptContext.finalSystemSections
            ? {
              finalSystemSections: snapshot.promptContext.finalSystemSections.map(clonePromptSection),
            }
            : {}),
          ...(snapshot.promptContext.providerObservability
            ? {
              providerObservability: {
                ...snapshot.promptContext.providerObservability,
                systemRole: { ...snapshot.promptContext.providerObservability.systemRole },
                providerWireMessages: snapshot.promptContext.providerObservability.providerWireMessages
                  .map(message => ({ ...message })),
              },
            }
            : {}),
          ...(snapshot.promptContext.response
            ? {
              response: {
                ...snapshot.promptContext.response,
              },
            }
            : {}),
        },
      }
      : {}),
    ...(snapshot.toolContext
      ? {
        toolContext: {
          activeTools: snapshot.toolContext.activeTools.map(tool => ({
            ...tool,
            inputSchema: structuredClone(tool.inputSchema),
          })),
          ...(snapshot.toolContext.adaptiveSnapshot
            ? {
              adaptiveSnapshot: {
                ...snapshot.toolContext.adaptiveSnapshot,
                tools: snapshot.toolContext.adaptiveSnapshot.tools.map(tool => ({ ...tool })),
                skipped: snapshot.toolContext.adaptiveSnapshot.skipped.map(skip => ({
                  ...skip,
                  ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
                })),
                counts: { ...snapshot.toolContext.adaptiveSnapshot.counts },
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

function buildTurnFromSession(turn: AdminSessionTurnData): PromptMonitorTurn {
  const latestStageAt = turn.stages.reduce(
    (latest, stage) => Math.max(latest, stage.observedAt),
    0,
  );
  const latestEventAt = Math.max(
    turn.record.completedAt,
    turn.snapshot?.capturedAt ?? 0,
    latestStageAt,
  );

  return {
    turnId: turn.record.turnId,
    requestId: turn.record.requestId,
    channelId: turn.record.channelId,
    latestEventAt,
    record: { ...turn.record },
    snapshot: turn.snapshot ? cloneSnapshot(turn.snapshot) : null,
    promptLoom: turn.promptLoom ? clonePromptLoom(turn.promptLoom) : null,
    stages: sortStages(turn.stages),
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

function clonePromptContextMessagesForLoom(
  messages: AdminTurnPromptContextMessage[] | undefined,
): AdminPromptLoomData['generatedPrompt']['contextMessages'] {
  return (messages?.map(clonePromptContextMessage) ?? []) as AdminPromptLoomData['generatedPrompt']['contextMessages'];
}

function clonePromptSectionsForLoom(
  sections: AdminPromptSectionTelemetry[] | undefined,
): AdminPromptLoomData['generatedPrompt']['inputSections'] {
  return (sections?.map(clonePromptSection) ?? []) as AdminPromptLoomData['generatedPrompt']['inputSections'];
}

function cloneProviderMessagesForLoom(
  messages: AdminTurnProviderWireMessage[] | undefined,
): AdminPromptLoomData['providerPayload']['providerMessages'] {
  return (messages?.map(message => ({ ...message })) ?? []) as AdminPromptLoomData['providerPayload']['providerMessages'];
}

function buildPromptLoomFromTurn(turn: PromptMonitorTurn): AdminPromptLoomData {
  const snapshot = turn.snapshot;
  const promptContext = snapshot?.promptContext;
  const response = promptContext?.response ?? null;
  const renderedChatOutput = response?.content ?? turn.record?.assistantMessage?.content ?? null;
  const historicalHits = collectHistoricalSnapshotHits(snapshot);
  const toolCalls = turn.record?.toolCalls ?? [];
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
      contextMessages: clonePromptContextMessagesForLoom(promptContext?.messages),
      inputSections: clonePromptSectionsForLoom(promptContext?.inputSections),
      runtimeContextSections: clonePromptSectionsForLoom(promptContext?.runtimeContextSections),
      finalSystemSections: clonePromptSectionsForLoom(promptContext?.finalSystemSections),
    },
    providerPayload: {
      finalSystemPrompt: promptContext?.finalSystemPrompt ?? null,
      providerMessages: cloneProviderMessagesForLoom(promptContext?.providerObservability?.providerWireMessages),
      activeTools: snapshot?.toolContext?.activeTools.map(tool => ({
        ...tool,
        inputSchema: structuredClone(tool.inputSchema),
      })) ?? [],
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
    toolActivity: {
      toolCalls: toolCalls.map(toolCall => structuredClone(toolCall)),
      toolResults: toolCalls
        .filter(hasToolResultPayload)
        .map(toolCall => structuredClone(toolCall)),
    },
  };
}

export function resolvePromptMonitorPromptLoom(turn: PromptMonitorTurn): AdminPromptLoomData {
  return turn.promptLoom ? clonePromptLoom(turn.promptLoom) : buildPromptLoomFromTurn(turn);
}

function readSnapshotEnvelopeData(
  event: GardenEventEnvelope,
): AdminTurnSnapshotData | null {
  if (event.type !== 'agent.turn.snapshot' || typeof event.data !== 'object' || event.data === null) {
    return null;
  }
  const snapshot = (event.data as { snapshot?: AdminTurnSnapshotData }).snapshot;
  if (!snapshot || typeof snapshot.turnId !== 'string' || typeof snapshot.channelId !== 'string') {
    return null;
  }
  return cloneSnapshot(snapshot);
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

export function buildPromptMonitorTurns(
  turns: readonly AdminSessionTurnData[],
): PromptMonitorTurn[] {
  return sortTurns(turns.map(buildTurnFromSession));
}

export function mergePromptMonitorEvent(
  turns: readonly PromptMonitorTurn[],
  event: GardenEventEnvelope,
): PromptMonitorTurn[] {
  const snapshot = readSnapshotEnvelopeData(event);
  const stage = readStageEnvelopeData(event);
  if (!snapshot && !stage) {
    return [...turns];
  }

  const turnId = snapshot?.turnId ?? stage?.turnId;
  const channelId = snapshot?.channelId ?? stage?.channelId;
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
    };

  const remaining = turns.filter(candidate => candidate.turnId !== turnId);
  return sortTurns([nextTurn, ...remaining]);
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
