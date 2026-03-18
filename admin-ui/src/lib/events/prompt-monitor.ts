import type {
  AdminSessionTurnData,
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
  stages: AdminTurnStageTelemetry[];
}

export interface PromptMonitorMetrics {
  promptDurationMs: number | null;
  ttftMs: number | null;
  firstTokenSource: string | null;
  promptMode: string | null;
  contextMessages: number | null;
  systemPromptChars: number | null;
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

function cloneSnapshot(snapshot: AdminTurnSnapshotData): AdminTurnSnapshotData {
  return {
    ...snapshot,
    ...(snapshot.prompt ? { prompt: { ...snapshot.prompt } } : {}),
    ...(snapshot.promptContext
      ? {
        promptContext: {
          ...snapshot.promptContext,
          messages: snapshot.promptContext.messages.map(message => ({ ...message })),
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
    stages: sortStages(turn.stages),
  };
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
