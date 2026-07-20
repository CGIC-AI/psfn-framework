import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '$lib/types';
import { deriveContextCoherenceTelemetry } from './context-coherence.js';

const HOUR_MS = 3_600_000;

function coherenceEvent(
  signal: string,
  timestamp: number,
  options: { missingTurn?: boolean; groundTruth?: boolean } = {},
): TelemetryEvent {
  return {
    type: 'context.coherence.detected',
    timestamp,
    data: {
      schemaVersion: 1,
      id: `${signal}:${timestamp}`,
      signal,
      source: signal === 'concern_rumination' ? 'observer_eval' : 'turn_end',
      timestamp,
      channelId: 'api:test',
      detail: 'test_fixture',
      groundTruth: options.groundTruth === true,
      ...(signal === 'operator_intervention' ? { operatorLabel: 'looping' } : {}),
      context: {
        recentMirrorNoteCount: 2,
        timeGapMs: 60_000,
        activeConcernCount: 3,
      },
      correlations: options.missingTurn
        ? [{
            kind: 'missing_turn',
            healed: true,
            expectedMinEntryId: 42,
            observedMaxEntryId: 40,
          }]
        : [],
      eligibleForEmotionAppraisal: false,
      eligibleForMemoryCandidacy: false,
    },
  };
}

describe('context-coherence Garden telemetry model', () => {
  it('builds an hourly trend and per-signal breakdown from the shared event stream', () => {
    const now = (12 * HOUR_MS) - 1;
    const events: TelemetryEvent[] = [
      coherenceEvent('confusion_ask', (9 * HOUR_MS) + 5, { missingTurn: true }),
      coherenceEvent('confusion_ask', (10 * HOUR_MS) + 5),
      coherenceEvent('looping', (10 * HOUR_MS) + 40),
      coherenceEvent('concern_rumination', (11 * HOUR_MS) + 20),
      coherenceEvent('operator_intervention', (11 * HOUR_MS) + 59, { groundTruth: true }),
      { type: 'context.coherence.detected', timestamp: now, data: { signal: 'unknown' } },
      {
        ...coherenceEvent('looping', now),
        data: {
          ...(coherenceEvent('looping', now).data as Record<string, unknown>),
          operatorLabel: 42,
        },
      },
      {
        ...coherenceEvent('looping', now),
        data: {
          ...(coherenceEvent('looping', now).data as Record<string, unknown>),
          unexpected: 'extension',
        },
      },
      { type: 'agent.turn.stage', timestamp: now, data: {} },
    ];

    const model = deriveContextCoherenceTelemetry(events, now);

    expect(model.total).toBe(5);
    expect(model.breakdown).toEqual({
      confusion_ask: 2,
      looping: 1,
      confabulation_self_report: 0,
      concern_rumination: 1,
      operator_intervention: 1,
    });
    expect(model.trend.slice(-3)).toEqual([1, 2, 2]);
    expect(model.missingTurnCorrelatedCount).toBe(1);
    expect(model.groundTruthCount).toBe(1);
    expect(model.latest?.context).toEqual({
      recentMirrorNoteCount: 2,
      timeGapMs: 60_000,
      activeConcernCount: 3,
    });
  });
});
