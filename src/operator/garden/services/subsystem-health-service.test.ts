import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { buildTurnPerformanceEvent } from '../../../shared/telemetry/turn-performance.js';
import {
  AdminSubsystemHealthDataService,
  type SubsystemLaneHealth,
  type SubsystemSchedulerStateProvider,
} from './subsystem-health-service.js';

function laneById(lanes: SubsystemLaneHealth[], id: string): SubsystemLaneHealth {
  const lane = lanes.find(candidate => candidate.id === id);
  if (!lane) throw new Error(`Lane not found: ${id}`);
  return lane;
}

describe('AdminSubsystemHealthDataService', () => {
  it('surfaces zero configured operator-alert sinks as a degraded Garden banner', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({
      eventBus: bus,
      operatorAlerting: {
        configuredSinks: [],
        status: 'unconfigured',
        warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
      },
    });

    expect((await service.getSnapshot()).operatorAlerting).toEqual({
      configuredSinks: [],
      status: 'unconfigured',
      warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
    });
  });

  it('reports never-fired event lanes as "never" with no fabricated data', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({
      eventBus: bus,
      processStartedAt: 1_000,
      now: () => 5_000,
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.processStartedAt).toBe(1_000);
    expect(snapshot.generatedAt).toBe(5_000);

    for (const laneId of [
      'near_turn',
      'episode_synthesis',
      'active_context',
      'extraction',
      'retrieval',
      'social_graph',
    ]) {
      const lane = laneById(snapshot.lanes, laneId);
      expect(lane.source).toBe('event_bus');
      expect(lane.sinceProcessStart).toBe(true);
      expect(lane.status).toBe('never');
      expect(lane.lastEventAt).toBeNull();
      expect(lane.lastOutcome).toBeNull();
      expect(lane.observedEventCount).toBe(0);
      expect(lane.recent).toEqual([]);
      expect(lane.counts).toEqual({});
    }
  });

  it('surfaces the startup memory-subject classification coverage count', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({
      eventBus: bus,
      processStartedAt: 1_000,
      now: () => 5_000,
      startupMemorySubjectClassificationCoverage: {
        checkedAt: 4_000,
        totalMemoryCount: 12,
        currentClassificationCount: 9,
        missingCurrentClassificationCount: 3,
      },
    });

    const lane = laneById((await service.getSnapshot()).lanes, 'subject_classification_coverage');
    expect(lane).toMatchObject({
      status: 'degraded',
      lastOutcome: 'degraded',
      lastReason: 'missing_current_classifications',
      lastEventAt: 4_000,
      counts: {
        totalMemoryCount: 12,
        currentClassificationCount: 9,
        missingCurrentClassificationCount: 3,
      },
      observedEventCount: 1,
    });
  });

  it('captures episode-synthesis skips with the gate reason', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });

    await bus.emit('memory.episode_synthesis.gate', {
      sessionId: 's1',
      channelId: 'c1',
      trigger: 'timer',
      outcome: 'skipped',
      reason: 'below_relevance_minimum',
      newEntryCount: 3,
      relevantTurnCount: 1,
      minRelevantTurns: 2,
      timestamp: 10,
    });

    const lane = laneById((await service.getSnapshot()).lanes, 'episode_synthesis');
    expect(lane.status).toBe('skipped');
    expect(lane.lastOutcome).toBe('skipped');
    expect(lane.lastReason).toBe('below_relevance_minimum');
    expect(lane.lastError).toBeNull();
    expect(lane.counts).toEqual({ newEntryCount: 3, relevantTurnCount: 1, minRelevantTurns: 2 });
    expect(lane.observedEventCount).toBe(1);
    expect(lane.recent).toHaveLength(1);
    expect(lane.recent[0].outcome).toBe('skipped');
  });

  it('marks a processed gate as ok and keeps newest observation first', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });

    await bus.emit('memory.episode_synthesis.gate', {
      sessionId: 's1', channelId: 'c1', trigger: 'timer', outcome: 'skipped',
      reason: 'no_new_messages', newEntryCount: 0, relevantTurnCount: 0, minRelevantTurns: 2, timestamp: 1,
    });
    await bus.emit('memory.episode_synthesis.gate', {
      sessionId: 's1', channelId: 'c1', trigger: 'turn_threshold', outcome: 'processed',
      newEntryCount: 5, relevantTurnCount: 4, minRelevantTurns: 2, timestamp: 2,
    });

    const lane = laneById((await service.getSnapshot()).lanes, 'episode_synthesis');
    expect(lane.status).toBe('ok');
    expect(lane.lastOutcome).toBe('ran');
    expect(lane.lastReason).toBeNull();
    expect(lane.observedEventCount).toBe(2);
    // Newest first.
    expect(lane.recent[0].outcome).toBe('ran');
    expect(lane.recent[1].outcome).toBe('skipped');
  });

  it('surfaces active-context refresh failures and turn degradation reasons', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });

    await bus.emit('memory.active_context.refresh', {
      channelId: 'c1', key: 'k', phase: 'degraded', error: 'retrieval timeout', timestamp: 1,
    });
    let lane = laneById((await service.getSnapshot()).lanes, 'active_context');
    expect(lane.status).toBe('failed');
    expect(lane.lastError).toBe('retrieval timeout');

    await bus.emit('memory.active_context.turn_degraded', {
      channelId: 'c1', key: 'k', reason: 'stale', refreshStatus: 'refreshing',
      turnId: 't1', requestId: 'r1', timestamp: 2,
    });
    lane = laneById((await service.getSnapshot()).lanes, 'active_context');
    expect(lane.status).toBe('degraded');
    expect(lane.lastReason).toBe('stale');
  });

  it('records extraction counts as a clean run', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });

    await bus.emit('memory.extraction.end', {
      channelId: 'c1', count: 4, acceptedCount: 3, rejectedCount: 1, writeCount: 3,
    });

    const lane = laneById((await service.getSnapshot()).lanes, 'extraction');
    expect(lane.status).toBe('ok');
    expect(lane.counts.extracted).toBe(4);
    expect(lane.counts.accepted).toBe(3);
    expect(lane.counts.written).toBe(3);
  });

  it('makes per-kind background-job failure rates loud', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });
    const emitBackgroundTerminal = async (
      traceId: string,
      kind: 'memory_extraction' | 'emotion_appraisal' | 'auto_compaction',
      state: 'succeeded' | 'failed',
      reason: 'completed' | 'source_missing' | 'source_mismatch',
      timestampMs: number,
    ) => bus.emit('agent.turn.performance', buildTurnPerformanceEvent({
      traceId,
      stage: 'background_job_state',
      backgroundJobKind: kind,
      backgroundJobState: state,
      backgroundJobReason: reason,
      timestampMs,
      monotonicAtMs: timestampMs,
    }));

    await emitBackgroundTerminal(
      'auto-1',
      'auto_compaction',
      'failed',
      'source_missing',
      1,
    );
    await emitBackgroundTerminal(
      'auto-2',
      'auto_compaction',
      'failed',
      'source_mismatch',
      2,
    );
    await emitBackgroundTerminal(
      'memory-1',
      'memory_extraction',
      'succeeded',
      'completed',
      3,
    );
    await emitBackgroundTerminal(
      'memory-2',
      'memory_extraction',
      'failed',
      'source_missing',
      4,
    );
    await emitBackgroundTerminal(
      'memory-2',
      'memory_extraction',
      'failed',
      'source_missing',
      4,
    );
    await emitBackgroundTerminal(
      'emotion-1',
      'emotion_appraisal',
      'succeeded',
      'completed',
      5,
    );

    expect(laneById((await service.getSnapshot()).lanes, 'background_work:auto_compaction'))
      .toMatchObject({
        status: 'failed',
        lastOutcome: 'failed',
        lastReason: 'source_mismatch',
        counts: {
          succeeded: 0,
          failed: 2,
          terminal: 2,
          successRatePct: 0,
        },
      });
    expect(laneById((await service.getSnapshot()).lanes, 'background_work:memory_extraction'))
      .toMatchObject({
        status: 'degraded',
        counts: {
          succeeded: 1,
          failed: 1,
          terminal: 2,
          successRatePct: 50,
        },
      });
    expect(laneById((await service.getSnapshot()).lanes, 'background_work:emotion_appraisal'))
      .toMatchObject({
        status: 'ok',
        counts: {
          succeeded: 1,
          failed: 0,
          terminal: 1,
          successRatePct: 100,
        },
      });
    expect(laneById(
      (await service.getSnapshot()).lanes,
      'background_work:intention_post_turn_hooks',
    ).status).toBe('never');
  });

  it('bounds the ring buffer to the configured limit', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus, ringLimit: 2 });

    for (let i = 0; i < 5; i += 1) {
      await bus.emit('memory.near_turn.cadence', {
        channelId: 'c1', sessionId: 's1', scope: 'direct', turnCount: i,
        newEntriesSinceLastRun: 1, firedAtMs: i, firesLastHour: 1, timestamp: i,
      });
    }

    const lane = laneById((await service.getSnapshot()).lanes, 'near_turn');
    expect(lane.observedEventCount).toBe(5);
    expect(lane.recent).toHaveLength(2);
    // Newest first: turnCount 4 then 3.
    expect(lane.recent[0].counts?.turnCount).toBe(4);
    expect(lane.recent[1].counts?.turnCount).toBe(3);
  });

  it('derives scheduler lanes: failed, stale, paused, never, and ok', async () => {
    const bus = new EventBus();
    const now = 1_000_000;
    const scheduler: SubsystemSchedulerStateProvider = {
      getFullData: () => ({
        tasks: [
          { id: 'ok-task', name: 'OK Task', type: 'every', state: 'idle', intervalMs: 60_000, lastRunAt: now - 10_000 },
          { id: 'stale-task', name: 'Stale Task', type: 'every', state: 'idle', intervalMs: 60_000, lastRunAt: now - 500_000 },
          { id: 'failed-task', name: 'Failed Task', type: 'every', state: 'idle', intervalMs: 60_000, lastRunAt: now - 10_000, lastError: 'boom' },
          { id: 'paused-task', name: 'Paused Task', type: 'every', state: 'paused', intervalMs: 60_000, lastRunAt: now - 10_000 },
          { id: 'never-task', name: 'Never Task', type: 'every', state: 'idle', intervalMs: 60_000 },
          { id: 'denied-task', name: 'Denied Task', type: 'every', state: 'idle', intervalMs: 60_000, lastRunAt: now - 10_000, lastDeniedReason: 'tier_denied' },
        ],
      }),
    };
    const service = new AdminSubsystemHealthDataService({ eventBus: bus, scheduler, now: () => now });

    const lanes = (await service.getSnapshot()).lanes;
    expect(laneById(lanes, 'scheduler:ok-task').status).toBe('ok');
    expect(laneById(lanes, 'scheduler:stale-task').status).toBe('stale');

    const failed = laneById(lanes, 'scheduler:failed-task');
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('boom');

    expect(laneById(lanes, 'scheduler:paused-task').status).toBe('paused');
    expect(laneById(lanes, 'scheduler:never-task').status).toBe('never');

    const denied = laneById(lanes, 'scheduler:denied-task');
    expect(denied.status).toBe('skipped');
    expect(denied.lastReason).toBe('tier_denied');
  });

  it('surfaces scheduler inspection failures as an explicit failed lane', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({
      eventBus: bus,
      scheduler: {
        getFullData: () => {
          throw new Error('scheduler store unavailable');
        },
      },
      now: () => 1_000_000,
    });

    const lane = laneById((await service.getSnapshot()).lanes, 'scheduler:health-read');
    expect(lane).toMatchObject({
      source: 'scheduler',
      sinceProcessStart: false,
      status: 'failed',
      lastEventAt: 1_000_000,
      lastOutcome: 'failed',
      lastError: 'scheduler store unavailable',
      observedEventCount: 0,
      recent: [],
    });
  });

  it('stops recording after dispose', async () => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus });
    service.dispose();

    await bus.emit('memory.near_turn.cadence', {
      channelId: 'c1', sessionId: 's1', scope: 'direct', turnCount: 1,
      newEntriesSinceLastRun: 1, firedAtMs: 1, firesLastHour: 1, timestamp: 1,
    });

    expect(laneById((await service.getSnapshot()).lanes, 'near_turn').status).toBe('never');
  });

  it('reports persisted episodic processor watermarks as current, stale, or never at twice their interval', async () => {
    const bus = new EventBus();
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    const service = new AdminSubsystemHealthDataService({
      eventBus: bus,
      now: () => now,
      watermarkProvider: {
        listProcessingWatermarkHealth: async () => [
          {
            processor: 'episodic_synthesis',
            latestWatermark: {
              id: 'watermark-synthesis',
              processor: 'episodic_synthesis',
              sourceRef: 'discord:main',
              previousWatermarkJson: {},
              nextWatermarkJson: {},
              status: 'active',
              reconciliationStatus: 'clean',
              artifactsJson: {},
              lastProcessedAt: '2026-07-30T11:40:00.000Z',
              updatedAt: '2026-07-30T11:40:00.000Z',
            },
            scopeCount: 1,
            blockedScopeCount: 0,
          },
          {
            processor: 'arc_formation',
            latestWatermark: {
              id: 'watermark-arc',
              processor: 'arc_formation',
              sourceRef: 'discord:main',
              previousWatermarkJson: {},
              nextWatermarkJson: {},
              status: 'active',
              reconciliationStatus: 'clean',
              artifactsJson: {},
              lastProcessedAt: '2026-07-15T00:00:00.000Z',
              updatedAt: '2026-07-15T00:00:00.000Z',
            },
            scopeCount: 1,
            blockedScopeCount: 0,
          },
        ],
      },
      watermarkDefinitions: [
        {
          processor: 'episodic_synthesis',
          label: 'Episode synthesis watermark',
          description: 'Candidate synthesis progress.',
          intervalMs: 30 * 60_000,
        },
        {
          processor: 'arc_formation',
          label: 'Arc formation watermark',
          description: 'Cross-day arc formation progress.',
          intervalMs: 6 * 24 * 60 * 60_000,
        },
        {
          processor: 'wiki_pass',
          label: 'Wiki pass watermark',
          description: 'Wiki synthesis progress.',
          intervalMs: 36 * 60 * 60_000,
        },
      ],
    });

    const lanes = (await service.getSnapshot()).lanes;
    expect(laneById(lanes, 'watermark:episodic_synthesis')).toMatchObject({
      source: 'watermark',
      sinceProcessStart: false,
      status: 'ok',
      lastRunAt: Date.parse('2026-07-30T11:40:00.000Z'),
      intervalMs: 30 * 60_000,
      counts: { scopeCount: 1 },
    });
    expect(laneById(lanes, 'watermark:arc_formation')).toMatchObject({
      source: 'watermark',
      status: 'stale',
      lastRunAt: Date.parse('2026-07-15T00:00:00.000Z'),
    });
    expect(laneById(lanes, 'watermark:wiki_pass')).toMatchObject({
      source: 'watermark',
      status: 'never',
      lastRunAt: null,
      counts: { scopeCount: 0 },
    });
  });

  it('surfaces episodic watermark inspection failures as an explicit failed lane', async () => {
    const service = new AdminSubsystemHealthDataService({
      eventBus: new EventBus(),
      now: () => 1_000_000,
      watermarkProvider: {
        listProcessingWatermarkHealth: async () => {
          throw new Error('watermark store unavailable');
        },
      },
      watermarkDefinitions: [{
        processor: 'episodic_synthesis',
        label: 'Episode synthesis watermark',
        description: 'Candidate synthesis progress.',
        intervalMs: 60_000,
      }],
    });

    expect(laneById((await service.getSnapshot()).lanes, 'watermark:health-read')).toMatchObject({
      source: 'watermark',
      sinceProcessStart: false,
      status: 'failed',
      lastEventAt: 1_000_000,
      lastOutcome: 'failed',
      lastError: 'watermark store unavailable',
    });
  });
});

describe('subsystem health page contract', () => {
  it('renders durable episodic watermark lanes instead of filtering them out', () => {
    const page = readFileSync(
      new URL('../../../../admin-ui/src/routes/subsystem-health/+page.svelte', import.meta.url),
      'utf8',
    );

    expect(page).toContain("lane.source === 'watermark'");
    expect(page).toContain('{#each watermarkLanes as lane (lane.id)}');
    expect(page).toContain('Episodic processor watermarks');
  });
});
