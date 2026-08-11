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
        companionId: 'companion',
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

  it('projects a content-free per-message waterfall with explicit not-run stages', () => {
    const tracker = new TurnPerformanceTracker();
    const base = {
      traceId: 'message-1',
      requestId: 'message-1',
      turnId: 'turn-1',
      companionId: 'companion-a',
      channelId: 'discord:shared-room',
      channelType: 'discord',
    } as const;
    tracker.observe(event({
      ...base,
      stage: 'cogsec_local_screening',
      stageStatus: 'observed',
      monotonicAtMs: 110,
      timestampMs: 1_010,
      durationMs: 10,
    }));
    tracker.observe(event({
      ...base,
      stage: 'cogsec_l2_screening',
      stageStatus: 'not_run',
      monotonicAtMs: 110,
      timestampMs: 1_010,
    }));
    tracker.observe(event({
      ...base,
      stage: 'cogsec_l3_screening',
      stageStatus: 'not_run',
      monotonicAtMs: 110,
      timestampMs: 1_010,
    }));
    tracker.observe(event({
      ...base,
      stage: 'channel_queue_wait',
      monotonicAtMs: 130,
      timestampMs: 1_030,
      durationMs: 20,
    }));
    tracker.observe(event({
      ...base,
      stage: 'prompt_assembly',
      monotonicAtMs: 150,
      timestampMs: 1_050,
      durationMs: 20,
    }));
    tracker.observe(event({
      ...base,
      stage: 'provider_complete',
      monotonicAtMs: 250,
      timestampMs: 1_150,
      durationMs: 100,
    }));
    tracker.observe(event({
      ...base,
      stage: 'outbound_delivery',
      monotonicAtMs: 270,
      timestampMs: 1_170,
      durationMs: 20,
    }));

    expect(tracker.recentWaterfalls()).toEqual([{
      traceId: 'message-1',
      turnId: 'turn-1',
      requestId: 'message-1',
      companionId: 'companion-a',
      channelId: 'discord:shared-room',
      channelType: 'discord',
      observedAtMs: 1_170,
      totalObservedMs: 170,
      stages: [
        { stage: 'local_screening', label: 'Local screening', status: 'observed', durationMs: 10 },
        { stage: 'l2', label: 'L2', status: 'not_run', durationMs: null },
        { stage: 'l3', label: 'L3', status: 'not_run', durationMs: null },
        { stage: 'channel_queue', label: 'Channel queue', status: 'observed', durationMs: 20 },
        { stage: 'prompt_assembly', label: 'Prompt assembly', status: 'observed', durationMs: 20 },
        { stage: 'model_provider', label: 'Model / provider', status: 'observed', durationMs: 100 },
        { stage: 'outbound_delivery', label: 'Outbound delivery', status: 'observed', durationMs: 20 },
      ],
    }]);
  });

  it('keys identical shared-room message ids by companion without cross-companion leakage', () => {
    const tracker = new TurnPerformanceTracker();
    for (const [companionId, durationMs] of [['companion-a', 5], ['companion-b', 50]] as const) {
      tracker.observe(event({
        traceId: 'same-platform-message-id',
        requestId: 'same-platform-message-id',
        companionId,
        channelId: 'discord:shared-room',
        channelType: 'discord',
        stage: 'cogsec_local_screening',
        stageStatus: 'observed',
        monotonicAtMs: 100 + durationMs,
        timestampMs: 1_000 + durationMs,
        durationMs,
      }));
    }

    expect(tracker.recentWaterfalls({ companionId: 'companion-a' })).toHaveLength(1);
    expect(tracker.recentWaterfalls({ companionId: 'companion-a' })[0]).toMatchObject({
      companionId: 'companion-a',
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'local_screening', durationMs: 5 }),
      ]),
    });
    expect(tracker.recentWaterfalls({ companionId: 'companion-b' })[0]).toMatchObject({
      companionId: 'companion-b',
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'local_screening', durationMs: 50 }),
      ]),
    });
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

  it('accepts content-free durable background lifecycle dimensions', () => {
    expect(parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'background-job-1',
      stage: 'background_job_state',
      monotonicAtMs: 100,
      timestampMs: 200,
      queueDepth: 3,
      durationMs: 25,
      backgroundJobAgeMs: 500,
      backgroundSessionIdHash: 'a'.repeat(64),
      backgroundJobAttemptCount: 1,
      backgroundJobKind: 'memory_extraction',
      backgroundJobState: 'succeeded',
      backgroundJobReason: 'completed',
      deferReason: 'succeeded',
    })).toMatchObject({
      backgroundSessionIdHash: 'a'.repeat(64),
      backgroundJobAttemptCount: 1,
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

  it('accepts explicit skipped-stage state without fabricating a zero duration', () => {
    const parsed = parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'trace-fast-path',
      stage: 'cogsec_l2_screening',
      stageStatus: 'not_run',
      monotonicAtMs: 100,
      timestampMs: 200,
      companionId: 'companion-a',
    });
    expect(parsed.stageStatus).toBe('not_run');
    expect(parsed.durationMs).toBeUndefined();
  });

  it('rejects a skipped stage carrying a misleading zero duration', () => {
    expect(() => parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'trace-fast-path',
      stage: 'cogsec_l3_screening',
      stageStatus: 'not_run',
      monotonicAtMs: 100,
      timestampMs: 200,
      durationMs: 0,
    })).toThrow('not_run stage must not carry durationMs');
  });

  it('rejects a raw session id disguised as a background session hash', () => {
    expect(() => parseTurnPerformanceEvent({
      schemaVersion: 1,
      traceId: 'background-job-1',
      stage: 'background_job_state',
      monotonicAtMs: 100,
      timestampMs: 200,
      backgroundSessionIdHash: 'discord:private-partner-channel',
    })).toThrow('must be a SHA-256 hex digest');
  });
});
