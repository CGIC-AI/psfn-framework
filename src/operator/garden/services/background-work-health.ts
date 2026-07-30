import {
  BACKGROUND_WORK_KINDS,
  type BackgroundWorkKind,
} from '../../../core/agent/background-work/types.js';
import type { EventMap } from '../../../shared/event-bus.js';

export const BACKGROUND_WORK_HEALTH_LANES = BACKGROUND_WORK_KINDS.map(kind => ({
  id: `background_work:${kind}`,
  label: `Background work: ${kind.replaceAll('_', ' ')}`,
  description: `Terminal success/failure rate for ${kind} jobs since process start.`,
}));

interface BackgroundWorkTerminalCounts {
  succeeded: number;
  failed: number;
}

export interface BackgroundWorkHealthUpdate {
  laneId: string;
  at: number;
  outcome: 'ran' | 'degraded' | 'failed';
  reason?: string;
  counts: {
    succeeded: number;
    failed: number;
    terminal: number;
    successRatePct: number;
  };
}

/**
 * Aggregates process-local terminal job telemetry once per durable job id.
 *
 * Supervisor terminal telemetry uses the job id as traceId. Replayed terminal
 * observations must not distort the operator-facing rate.
 */
export class BackgroundWorkHealthAccumulator {
  private readonly counts = new Map<BackgroundWorkKind, BackgroundWorkTerminalCounts>(
    BACKGROUND_WORK_KINDS.map(kind => [kind, { succeeded: 0, failed: 0 }]),
  );
  private readonly observedTerminalJobIds = new Set<string>();

  observe(
    payload: EventMap['agent.turn.performance'],
    fallbackTimestampMs: number,
  ): BackgroundWorkHealthUpdate | null {
    if (payload.stage !== 'background_job_state'
      || !payload.backgroundJobKind
      || (payload.backgroundJobState !== 'succeeded'
        && payload.backgroundJobState !== 'failed')) {
      return null;
    }
    if (this.observedTerminalJobIds.has(payload.traceId)) return null;
    this.observedTerminalJobIds.add(payload.traceId);

    const counts = this.counts.get(payload.backgroundJobKind);
    if (!counts) return null;
    if (payload.backgroundJobState === 'succeeded') counts.succeeded += 1;
    else counts.failed += 1;
    const terminal = counts.succeeded + counts.failed;
    const successRatePct = Math.round((counts.succeeded / terminal) * 10_000) / 100;
    const outcome = counts.failed === 0
      ? 'ran'
      : counts.succeeded === 0
        ? 'failed'
        : 'degraded';

    return {
      laneId: `background_work:${payload.backgroundJobKind}`,
      at: typeof payload.timestampMs === 'number' && Number.isFinite(payload.timestampMs)
        ? payload.timestampMs
        : fallbackTimestampMs,
      outcome,
      ...(payload.backgroundJobReason ? { reason: payload.backgroundJobReason } : {}),
      counts: {
        succeeded: counts.succeeded,
        failed: counts.failed,
        terminal,
        successRatePct,
      },
    };
  }
}
