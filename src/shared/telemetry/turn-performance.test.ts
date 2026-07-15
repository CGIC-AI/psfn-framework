import { describe, expect, it } from 'vitest';
import {
  buildTurnPerformanceEvent,
  parseTurnPerformanceEvent,
  TurnPerformanceTracker,
  type TurnPerformanceEventInput,
} from './turn-performance.js';

function event(input: TurnPerformanceEventInput) {
  return buildTurnPerformanceEvent(input);
}

describe('TurnPerformanceTracker', () => {
  it('derives live LLM TTFT and TTFA percentiles from one trace key', () => {
    const tracker = new TurnPerformanceTracker();
    for (const [traceId, offset] of [['a', 0], ['b', 100], ['c', 200]] as const) {
      tracker.observe(event({
        traceId,
        stage: 'speech_end',
        monotonicAtMs: offset,
        timestampMs: offset,
        companionId: 'purrsephone',
        channelType: 'voice',
      }));
      tracker.observe(event({
        traceId,
        stage: 'provider_request',
        monotonicAtMs: offset + 10,
        timestampMs: offset + 10,
        provider: 'test',
        model: 'chat-model',
      }));
      tracker.observe(event({
        traceId,
        stage: 'provider_first_token',
        monotonicAtMs: offset + (traceId === 'a' ? 20 : traceId === 'b' ? 30 : 50),
        timestampMs: offset + 50,
        provider: 'test',
        model: 'chat-model',
      }));
      tracker.observe(event({
        traceId,
        stage: 'first_audible_playback',
        monotonicAtMs: offset + (traceId === 'a' ? 50 : traceId === 'b' ? 70 : 90),
        timestampMs: offset + 90,
        channelType: 'voice',
      }));
    }

    const snapshot = tracker.snapshot();
    const allTtft = snapshot.series.find(series => (
      series.metric === 'llm_ttft' && Object.keys(series.dimensions).length === 0
    ));
    const providerTtft = snapshot.series.find(series => (
      series.metric === 'llm_ttft' && series.dimensions.provider === 'test'
    ));
    const allTtfa = snapshot.series.find(series => (
      series.metric === 'ttfa' && Object.keys(series.dimensions).length === 0
    ));

    expect(allTtft?.percentiles).toEqual({ samples: 3, p50Ms: 20, p95Ms: 40, p99Ms: 40 });
    expect(providerTtft?.percentiles).toEqual(allTtft?.percentiles);
    expect(allTtfa?.percentiles).toEqual({ samples: 3, p50Ms: 70, p95Ms: 90, p99Ms: 90 });
  });

  it('reports direct wait durations and keeps only the bounded sample window', () => {
    const tracker = new TurnPerformanceTracker(2);
    for (const durationMs of [5, 10, 20]) {
      tracker.observe(event({
        traceId: `trace-${durationMs}`,
        stage: 'compaction_wait',
        monotonicAtMs: durationMs,
        timestampMs: durationMs,
        durationMs,
        backgroundContention: durationMs > 5,
      }));
    }

    const all = tracker.snapshot().series.find(series => (
      series.metric === 'compaction_wait' && Object.keys(series.dimensions).length === 0
    ));
    expect(all?.percentiles).toEqual({ samples: 2, p50Ms: 10, p95Ms: 20, p99Ms: 20 });
  });
});

describe('parseTurnPerformanceEvent', () => {
  it('accepts the closed content-free provider observation envelope', () => {
    expect(parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'trace-provider-1',
      stage: 'provider_first_token',
      monotonicAtMs: 100,
      timestampMs: 200,
      provider: 'openrouter',
      model: 'model-a',
      providerOutputKind: 'thinking',
    })).toMatchObject({
      traceId: 'trace-provider-1',
      providerOutputKind: 'thinking',
    });
  });

  it('rejects content fields at the gateway-agent boundary', () => {
    expect(() => parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'trace-private',
      stage: 'speech_end',
      monotonicAtMs: 100,
      timestampMs: 200,
      transcript: 'must never cross',
    })).toThrow('unsupported field "transcript"');
  });
});
