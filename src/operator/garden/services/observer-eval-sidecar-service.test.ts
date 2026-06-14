import { describe, expect, it, vi } from 'vitest';
import type {
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
      status: 'unavailable',
      observedAt: NOW_MS,
      runtime: null,
      persistence: {
        available: false,
        evalOwned: false,
        authoritative: false,
      },
    });
  });

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
