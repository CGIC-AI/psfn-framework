import { describe, expect, it, vi } from 'vitest';
import type {
  ObserverEvalSidecarLeverEventRecord,
  ObserverEvalSidecarLeverPersistencePort,
  ObserverEvalSidecarObservationRecord,
  ObserverEvalSidecarPersistencePort,
  ObserverEvalSidecarRunRecord,
} from '../../../core/eval/observer-sidecar/persistence.js';
import {
  createObserverEvalComparisonMetrics,
  OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
  OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
} from '../../../core/eval/observer-sidecar/persistence.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import {
  AdminObserverEvalSidecarDataService,
  ObserverEvalSidecarApiUnavailableError,
} from './observer-eval-sidecar-service.js';

const NOW_MS = 1_780_000_000_000;

describe('AdminObserverEvalSidecarDataService', () => {
  it('serializes observations without leaking raw sensitive identifiers or metadata', async () => {
    const observation = makeObservation();
    const persistence = makePersistence({ observations: [observation] });
    const service = new AdminObserverEvalSidecarDataService({
      persistence,
      nowMs: () => NOW_MS,
    });

    const result = await service.queryObservations({ limit: 10 });
    const json = JSON.stringify(result);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      observationId: 'observation-1',
      turn: {
        redactedIdentifiers: ['requestId', 'sourceMessageId', 'channelId'],
      },
      privacy: {
        privacyClass: 'private',
        redactionReason: 'private_channel_metadata_only',
      },
      authoritative: false,
    });
    expect(json).not.toContain('raw-request-id');
    expect(json).not.toContain('raw-source-message-id');
    expect(json).not.toContain('raw-channel-id');
    expect(json).not.toContain('raw-user-secret');
    expect(json).toContain('redactedIdentifiers');
  });

  it('returns unavailable health when no runtime or persistence is attached', async () => {
    const service = new AdminObserverEvalSidecarDataService({
      nowMs: () => NOW_MS,
    });

    await expect(service.queryObservations()).rejects.toBeInstanceOf(ObserverEvalSidecarApiUnavailableError);
    await expect(service.getHealth()).resolves.toEqual({
      companionId: null,
      operatingState: 'absent',
      binding: null,
      status: 'unavailable',
      observedAt: NOW_MS,
      runtime: null,
      persistence: {
        available: false,
        evalOwned: false,
        authoritative: false,
      },
      proactivityMode: 'off',
      lastTransition: null,
    });
  });

  it('pins operating health and terminal transitions to the exact companion binding', async () => {
    const companionId = '22222222-2222-4222-8222-222222222222';
    const runtime = {
      status: 'enabled' as const,
      observedAt: NOW_MS,
      sidecarId: 'emosim-vesper',
      enabled: true,
      available: true,
      accepting: true,
      queue: {
        queuedCount: 0,
        runningCount: 0,
        maxQueuedTurns: 32,
        overflowPolicy: 'drop_newest' as const,
        shuttingDown: false,
      },
      counts: {
        accepted: 1,
        completed: 1,
        dropped: 0,
        failed: 0,
        timedOut: 0,
        retried: 0,
        lifecycleHookFailed: 0,
        shutdownTimedOut: 0,
      },
      dropCounts: {},
      failureCounts: {},
    };
    const service = new AdminObserverEvalSidecarDataService({
      companionId,
      binding: {
        companionId,
        sidecarId: 'emosim-vesper',
        sessionLabel: 'emosim-session-vesper',
        agentName: 'emosim-agent-vesper',
      },
      configuredEnabled: true,
      proactivityMode: 'on',
      getHealthSnapshot: () => runtime,
      getLastTransition: () => ({
        correlationId: `felt-impulse:would_message:${NOW_MS}`,
        lever: 'would_message',
        stage: 'final_disposition',
        outcome: 'delivered',
        firedAtMs: NOW_MS,
        timestamp: NOW_MS,
      }),
    });

    await expect(service.getHealth()).resolves.toMatchObject({
      companionId,
      operatingState: 'on',
      binding: { companionId, sidecarId: 'emosim-vesper' },
      runtime: { sidecarId: 'emosim-vesper' },
      lastTransition: { stage: 'final_disposition', outcome: 'delivered' },
    });

    const wrongOwner = new AdminObserverEvalSidecarDataService({
      companionId,
      binding: {
        companionId,
        sidecarId: 'emosim-vesper',
        sessionLabel: 'emosim-session-vesper',
        agentName: 'emosim-agent-vesper',
      },
      configuredEnabled: true,
      proactivityMode: 'on',
      getHealthSnapshot: () => ({ ...runtime, sidecarId: 'emosim-nyx' }),
      getLastTransition: () => ({
        correlationId: `felt-impulse:would_message:${NOW_MS}`,
        lever: 'would_message',
        stage: 'final_disposition',
        outcome: 'delivered',
        firedAtMs: NOW_MS,
        timestamp: NOW_MS,
      }),
    });
    await expect(wrongOwner.getHealth()).resolves.toMatchObject({
      companionId,
      operatingState: 'unhealthy',
      runtime: null,
      lastTransition: null,
    });
  });

  it.each([
    { configuredEnabled: false, proactivityMode: 'off', state: 'disabled', status: 'disabled' },
    { configuredEnabled: true, proactivityMode: 'shadow', state: 'shadow', status: 'enabled' },
  ] as const)(
    'reports the $state operating state separately',
    async ({ configuredEnabled, proactivityMode, state, status }) => {
      const companionId = '22222222-2222-4222-8222-222222222222';
      const sidecarId = 'emosim-vesper';
      const service = new AdminObserverEvalSidecarDataService({
        companionId,
        binding: {
          companionId,
          sidecarId,
          sessionLabel: 'emosim-session-vesper',
          agentName: 'emosim-agent-vesper',
        },
        configuredEnabled,
        proactivityMode,
        getHealthSnapshot: () => configuredEnabled ? ({
          status: 'enabled',
          observedAt: NOW_MS,
          sidecarId,
          enabled: true,
          available: true,
          accepting: true,
          queue: {
            queuedCount: 0,
            runningCount: 0,
            maxQueuedTurns: 32,
            overflowPolicy: 'drop_newest',
            shuttingDown: false,
          },
          counts: {
            accepted: 0,
            completed: 0,
            dropped: 0,
            failed: 0,
            timedOut: 0,
            retried: 0,
            lifecycleHookFailed: 0,
            shutdownTimedOut: 0,
          },
          dropCounts: {},
          failureCounts: {},
        }) : null,
        nowMs: () => NOW_MS,
      });

      await expect(service.getHealth()).resolves.toMatchObject({
        companionId,
        operatingState: state,
        status,
      });
    },
  );

  it('returns redacted export payloads with pagination metadata', async () => {
    const observation = makeObservation();
    const persistence = makePersistence({ observations: [observation, makeObservation('observation-2')] });
    const service = new AdminObserverEvalSidecarDataService({
      persistence,
      nowMs: () => NOW_MS,
    });

    const exported = await service.exportObservations({ limit: 1, privacyClass: 'private' });

    expect(exported).toMatchObject({
      exportVersion: 'garden.observer-eval-sidecar.export.v1',
      generatedAtMs: NOW_MS,
      redacted: true,
      filters: {
        limit: 1,
        privacyClass: 'private',
      },
    });
    expect(exported.observations).toHaveLength(1);
  });

  it('reports hasMore=false when the result set exactly fills the page', async () => {
    const observations = [makeObservation('observation-1'), makeObservation('observation-2')];
    const runs = [makeRunRecord('run-1'), makeRunRecord('run-2')];
    const persistence = makePersistence({ observations, runs });
    const leverEvents = makeLeverPersistence([makeLeverEvent('event-1'), makeLeverEvent('event-2')]);
    const service = new AdminObserverEvalSidecarDataService({
      persistence,
      leverEvents,
      nowMs: () => NOW_MS,
    });

    const observationList = await service.queryObservations({ limit: 2 });
    expect(observationList.observations).toHaveLength(2);
    expect(observationList.pagination).toEqual({ limit: 2, count: 2, hasMore: false });

    const runList = await service.queryRuns({ limit: 2 });
    expect(runList.runs).toHaveLength(2);
    expect(runList.pagination).toEqual({ limit: 2, count: 2, hasMore: false });

    const eventList = await service.queryLeverEvents({ limit: 2 });
    expect(eventList.events).toHaveLength(2);
    expect(eventList.pagination).toEqual({ limit: 2, count: 2, hasMore: false });
  });

  it('reports hasMore=true by overfetching one row past the page', async () => {
    const observations = [
      makeObservation('observation-1'),
      makeObservation('observation-2'),
      makeObservation('observation-3'),
    ];
    const runs = [makeRunRecord('run-1'), makeRunRecord('run-2'), makeRunRecord('run-3')];
    const persistence = makePersistence({ observations, runs });
    const leverEvents = makeLeverPersistence([
      makeLeverEvent('event-1'),
      makeLeverEvent('event-2'),
      makeLeverEvent('event-3'),
    ]);
    const service = new AdminObserverEvalSidecarDataService({
      persistence,
      leverEvents,
      nowMs: () => NOW_MS,
    });

    const observationList = await service.queryObservations({ limit: 2 });
    expect(observationList.observations).toHaveLength(2);
    expect(observationList.pagination).toEqual({ limit: 2, count: 2, hasMore: true });
    expect(observationList.filters.limit).toBe(2);
    expect(persistence.queryObservations).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));

    const runList = await service.queryRuns({ limit: 2 });
    expect(runList.runs).toHaveLength(2);
    expect(runList.pagination).toEqual({ limit: 2, count: 2, hasMore: true });
    expect(persistence.queryRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));

    const eventList = await service.queryLeverEvents({ limit: 2 });
    expect(eventList.events).toHaveLength(2);
    expect(eventList.pagination).toEqual({ limit: 2, count: 2, hasMore: true });
    expect(leverEvents.queryLeverEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
  });
});

function makePersistence(input: {
  observations?: ObserverEvalSidecarObservationRecord[];
  runs?: ObserverEvalSidecarRunRecord[];
}): ObserverEvalSidecarPersistencePort {
  const observations = input.observations ?? [];
  const runs = input.runs ?? [];
  return {
    upsertRun: vi.fn(),
    getRun: vi.fn(),
    queryRuns: vi.fn(async query => runs.slice(0, query?.limit ?? runs.length)),
    recordObservation: vi.fn(),
    getObservation: vi.fn(),
    getLatestObservation: vi.fn(async () => observations[0] ?? null),
    queryObservations: vi.fn(async query => observations.slice(0, query?.limit ?? observations.length)),
    pruneExpiredRetention: vi.fn(),
  } as unknown as ObserverEvalSidecarPersistencePort;
}

function makeObservation(id = 'observation-1'): ObserverEvalSidecarObservationRecord {
  const privacy = {
    privacyClass: 'private' as const,
    sensitivity: 'personal' as const,
    channelVisibility: 'private' as const,
    rawContentRedacted: true,
    sensitiveIdentifiersRedacted: true,
    derivedTelemetryPermitted: true,
    redactionReason: 'private_channel_metadata_only' as const,
  };
  const retention = {
    retentionClass: 'standard' as const,
    policyId: 'observer-sidecar-test',
    capturedAtMs: NOW_MS,
    retainUntilMs: NOW_MS + 86_400_000,
    reason: 'test retention',
  };
  return {
    schemaVersion: 1,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    observationId: id,
    runId: 'run-1',
    sanitizedInput: {
      schemaVersion: 1,
      privacy,
      turn: {
        turnId: 'turn-1' as TurnID,
        channelType: 'api',
        messageTimestampMs: NOW_MS,
        redactedIdentifiers: ['requestId', 'sourceMessageId', 'channelId'],
      },
      source: {
        routingSource: 'api',
        isDirectMessage: true,
        channelPrivacy: 'private',
      },
      emotion: {
        snapshot: {
          vad: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
          mood: { valence: 0.1, arousal: 0.1, dominance: 0.02 },
          discrete: { concern: 0.3 },
          confidence: 0.7,
        },
        appraisalEntryCount: 1,
        snapshotRedacted: false,
      },
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: 42,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'personal',
      },
      provenance: {
        seam: 'substrate-agent.pre-turn.emotion-observed',
        capturedAt: NOW_MS,
        emotionSnapshotSource: 'observeEmotionState',
        correlation: {
          callType: 'chat',
          purposeRedacted: true,
        },
        redactedIdentifiers: ['emotionSessionId'],
      },
    },
    turnId: 'turn-1',
    capturedAtMs: NOW_MS,
    observedAtMs: NOW_MS + 1,
    status: 'ok',
    privacy,
    psfnEmotion: {
      snapshot: null,
      appraisalEntryCount: 1,
      snapshotSource: 'observeEmotionState',
    },
    comparisonMetrics: createObserverEvalComparisonMetrics(undefined, {
      safeDetail: true,
    }),
    metadata: {
      requestId: 'raw-request-id',
      sourceMessageId: 'raw-source-message-id',
      channelId: 'raw-channel-id',
      secret: 'raw-user-secret',
    },
    retention,
    createdAtMs: NOW_MS + 2,
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function makeRunRecord(runId: string): ObserverEvalSidecarRunRecord {
  return {
    schemaVersion: 1,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    runId,
    sidecarId: 'observer-sidecar-test',
    deployment: 'test',
    status: 'running',
    startedAtMs: NOW_MS,
    metadata: {},
    retention: {
      retentionClass: 'standard',
      policyId: 'observer-sidecar-test',
      capturedAtMs: NOW_MS,
      retainUntilMs: NOW_MS + 86_400_000,
      reason: 'test retention',
    },
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function makeLeverEvent(eventId: string): ObserverEvalSidecarLeverEventRecord {
  return {
    schemaVersion: 1,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    eventId,
    runId: 'run-1',
    lever: 'would_message',
    firedAtMs: NOW_MS,
    observationId: 'observation-1',
    detail: 'test lever event',
    stateValues: { socialNeed: 0.8 },
    sustainMs: 60_000,
    firstCrossingMs: NOW_MS - 60_000,
    cooldown: {
      cooldownMs: 300_000,
      previousFiredAtMs: null,
      refireReason: 'first_fire',
    },
    retention: {
      retentionClass: 'extended',
      policyId: 'observer-sidecar-test',
      capturedAtMs: NOW_MS,
      retainUntilMs: NOW_MS + 90 * 86_400_000,
      reason: 'test retention',
    },
    createdAtMs: NOW_MS,
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function makeLeverPersistence(
  events: ObserverEvalSidecarLeverEventRecord[],
): ObserverEvalSidecarLeverPersistencePort {
  return {
    recordLeverEvent: vi.fn(),
    queryLeverEvents: vi.fn(async query => events.slice(0, query?.limit ?? events.length)),
    loadLeverState: vi.fn(),
    saveLeverState: vi.fn(),
    pruneExpiredLeverEvents: vi.fn(),
  } as unknown as ObserverEvalSidecarLeverPersistencePort;
}
