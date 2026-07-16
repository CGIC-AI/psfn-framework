import type { PromptMonitorTurn } from '../../events/prompt-monitor';
import type { AdminTurnRetrievalTelemetry, AdminTurnStageTelemetry } from '../../types';

const NON_SUBSYSTEM_STAGES = new Set(['first-token', 'end']);

export interface PromptMonitorSubsystemTiming {
  stage: string;
  durationMs: number;
  durationSource: 'recorded' | 'elapsed_delta';
  elapsedMs: number;
  observedAt: number;
  data: Record<string, unknown>;
}

export interface PromptMonitorTimingSummary {
  subsystems: PromptMonitorSubsystemTiming[];
  subsystemTotalMs: number;
  totalElapsedMs: number | null;
  ttftMs: number | null;
  unattributedMs: number | null;
  overlapMs: number | null;
}

type PromptMonitorTurnWithRetrievals = PromptMonitorTurn & {
  retrievals?: AdminTurnRetrievalTelemetry[];
};

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stagesByObservation(stages: readonly AdminTurnStageTelemetry[]): AdminTurnStageTelemetry[] {
  return [...stages].sort((left, right) => {
    if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
    return left.elapsedMs - right.elapsedMs;
  });
}

export function resolvePromptMonitorRetrievals(
  turn: PromptMonitorTurn,
): readonly AdminTurnRetrievalTelemetry[] {
  const liveRetrievals = (turn as PromptMonitorTurnWithRetrievals).retrievals;
  if (Array.isArray(liveRetrievals)) return liveRetrievals;
  return turn.record?.observability?.retrievals ?? [];
}

export function buildPromptMonitorTimingSummary(
  turn: PromptMonitorTurn,
): PromptMonitorTimingSummary {
  const orderedStages = stagesByObservation(turn.stages);
  const subsystems: PromptMonitorSubsystemTiming[] = [];
  let previousElapsedMs = 0;

  for (const stage of orderedStages) {
    const elapsedDelta = Math.max(0, stage.elapsedMs - previousElapsedMs);
    const recordedDuration = finiteNonNegative(stage.data.durationMs);
    previousElapsedMs = stage.elapsedMs;

    if (NON_SUBSYSTEM_STAGES.has(stage.stage)) continue;
    subsystems.push({
      stage: stage.stage,
      durationMs: recordedDuration ?? elapsedDelta,
      durationSource: recordedDuration == null ? 'elapsed_delta' : 'recorded',
      elapsedMs: stage.elapsedMs,
      observedAt: stage.observedAt,
      data: stage.data,
    });
  }

  const promptStage = orderedStages.find(stage => stage.stage === 'prompt');
  const firstTokenStage = orderedStages.find(stage => stage.stage === 'first-token');
  const endStage = orderedStages.findLast(stage => stage.stage === 'end');
  const ttftMs = finiteNonNegative(promptStage?.data.ttftMs)
    ?? finiteNonNegative(firstTokenStage?.data.ttftMs)
    ?? finiteNonNegative(firstTokenStage?.elapsedMs);
  const totalElapsedMs = finiteNonNegative(endStage?.elapsedMs);
  const subsystemTotalMs = subsystems.reduce((total, stage) => total + stage.durationMs, 0);
  const difference = totalElapsedMs == null ? null : totalElapsedMs - subsystemTotalMs;

  return {
    subsystems,
    subsystemTotalMs,
    totalElapsedMs,
    ttftMs,
    unattributedMs: difference == null ? null : Math.max(0, difference),
    overlapMs: difference == null ? null : Math.max(0, -difference),
  };
}

export function describePromptMonitorTimingData(data: Record<string, unknown>): string[] {
  const details: string[] = [];
  const numericFields = [
    ['memoryChars', 'memory chars'],
    ['contextMessages', 'context messages'],
    ['systemPromptTokens', 'system prompt tokens'],
    ['assembledPromptTokens', 'assembled prompt tokens'],
  ] as const;
  for (const [field, label] of numericFields) {
    const value = finiteNonNegative(data[field]);
    if (value != null) details.push(`${value.toLocaleString()} ${label}`);
  }
  const mode = typeof data.mode === 'string'
    ? data.mode
    : typeof data.promptMode === 'string'
      ? data.promptMode
      : null;
  if (mode) details.push(`mode ${mode}`);
  return details;
}
