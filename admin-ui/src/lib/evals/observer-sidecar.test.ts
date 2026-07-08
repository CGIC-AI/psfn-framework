import { describe, expect, it } from 'vitest';
import type {
  AdminObserverEvalSidecarHealthData,
  AdminObserverEvalSidecarObservationView,
} from '$lib/api/endpoints/observer-eval-sidecar';
import {
  buildObserverEvalSidecarFilters,
  resolveObserverEvalSidecarPageState,
  topDiscreteEmotions,
} from './observer-sidecar';

const NOW_MS = 1_780_000_000_000;

describe('observer eval sidecar view helpers', () => {
  it('classifies loading, unavailable, empty, degraded, redacted, and populated states', () => {
    expect(resolveObserverEvalSidecarPageState({ loading: true })).toBe('loading');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      unavailableMessage: 'Observer eval sidecar backend unavailable',
    })).toBe('unavailable');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth({ persistenceAvailable: false }),
    })).toBe('unavailable');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth(),
      observations: [],
    })).toBe('empty');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth({ status: 'degraded' }),
      latestObservation: makeObservation({ status: 'ok', privacyClass: 'public' }),
      observations: [makeObservation({ status: 'ok', privacyClass: 'public' })],
    })).toBe('degraded');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth({ status: 'unavailable', persistenceAvailable: true }),
      latestObservation: makeObservation({ status: 'ok', privacyClass: 'public' }),
      observations: [makeObservation({ status: 'ok', privacyClass: 'public' })],
    })).toBe('degraded');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth(),
      latestObservation: makeObservation({ privacyClass: 'private' }),
      observations: [makeObservation({ privacyClass: 'private' })],
    })).toBe('redacted');
    expect(resolveObserverEvalSidecarPageState({
      loading: false,
      health: makeHealth(),
      latestObservation: makeObservation({ privacyClass: 'public' }),
      observations: [makeObservation({ privacyClass: 'public' })],
    })).toBe('populated');
  });

  it('normalizes observation filters from form values', () => {
    expect(buildObserverEvalSidecarFilters({
      timeRange: '1h',
      runId: ' run-1 ',
      privacyClass: 'private',
      status: 'degraded',
      minDivergenceScore: '1.9',
      limit: '25',
    }, NOW_MS)).toEqual({
      runId: 'run-1',
      privacyClass: 'private',
      status: 'degraded',
      minDivergenceScore: 1,
      limit: 25,
      sinceMs: NOW_MS - 60 * 60_000,
      untilMs: NOW_MS,
    });
  });

  it('sorts top PSFN discrete emotions by intensity', () => {
    expect(topDiscreteEmotions({
      vad: { valence: 0, arousal: 0, dominance: 0 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      confidence: 0.7,
      discrete: {
        concern: 0.2,
        joy: 0.8,
        anxiety: 0.5,
        neutral: 0,
      },
    }, 2)).toEqual([
      { emotion: 'joy', intensity: 0.8 },
      { emotion: 'anxiety', intensity: 0.5 },
    ]);
  });
});

function makeHealth(input: {
  status?: AdminObserverEvalSidecarHealthData['status'];
  persistenceAvailable?: boolean;
} = {}): AdminObserverEvalSidecarHealthData {
  const persistenceAvailable = input.persistenceAvailable ?? true;
  return {
    status: input.status ?? 'enabled',
    observedAt: NOW_MS,
    runtime: null,
    persistence: {
      available: persistenceAvailable,
      evalOwned: persistenceAvailable,
      authoritative: false,
    },
  };
}

function makeObservation(input: {
  status?: AdminObserverEvalSidecarObservationView['status'];
  privacyClass?: AdminObserverEvalSidecarObservationView['privacy']['privacyClass'];
} = {}): AdminObserverEvalSidecarObservationView {
  const privacyClass = input.privacyClass ?? 'public';
  return {
    observationId: 'observation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    capturedAtMs: NOW_MS,
    observedAtMs: NOW_MS,
    status: input.status ?? 'ok',
    privacy: {
      privacyClass,
      sensitivity: 'public',
      channelVisibility: 'public',
      rawContentRedacted: true,
      sensitiveIdentifiersRedacted: true,
      derivedTelemetryPermitted: true,
      redactionReason: 'public_metadata_only',
    },
    turn: {
      turnId: 'turn-1' as AdminObserverEvalSidecarObservationView['turn']['turnId'],
      channelType: 'api',
      messageTimestampMs: NOW_MS,
      redactedIdentifiers: ['requestId', 'sourceMessageId', 'channelId'],
    },
    source: {
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: null,
      appraisalEntryCount: 0,
      snapshotRedacted: false,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 12,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
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
    psfnEmotion: {
      snapshot: null,
      appraisalEntryCount: 0,
      snapshotSource: 'observeEmotionState',
    },
    projection: null,
    emosim: null,
    metrics: {
      schemaVersion: 1,
      metricsVersion: 'psfn.observer-sidecar.comparison-metrics.v1',
      status: 'available',
      agreementBand: 'aligned',
      score: {
        rawDivergenceScore: 0.1,
        confidenceWeightedDivergenceScore: 0.1,
        confidenceWeight: 1,
        components: [],
      },
      deltas: {
        valence: 0,
        arousal: 0,
        vadDistance: 0,
        dominance: 0,
        intensity: 0,
      },
      familyConfusion: {
        psfnPrimaryFamily: null,
        emosimPrimaryFamily: null,
        familyMismatch: false,
        familyOverlap: 1,
        psfnPrimaryLabel: null,
        emosimDominantEmotion: null,
        unmappedSignal: 0,
      },
      direction: {
        psfnDirection: null,
        emosimDirection: null,
        directionMismatch: false,
        suppressionOrDecayMismatch: false,
      },
      projection: {
        projectionConfidence: 1,
        lowConfidence: false,
        projectionAvailable: true,
        projectionFailed: false,
        confidenceWeight: 1,
      },
      privacy: {
        privacyClass,
        sensitivity: 'public',
        redactionReason: 'public_metadata_only',
        derivedTelemetryPermitted: true,
        redactedObservation: privacyClass !== 'public',
      },
      reasons: [],
      persistence: {
        schemaVersion: 1,
        metricsVersion: 'psfn.observer-sidecar.comparison-metrics.v1',
        divergenceScore: 0.1,
        vadDistance: 0,
        familyMismatch: false,
        directionMismatch: false,
        unmappedSignal: 0,
      },
    },
    retention: {
      retentionClass: 'standard',
      policyId: 'test-policy',
      capturedAtMs: NOW_MS,
      retainUntilMs: NOW_MS + 86_400_000,
      reason: 'test',
    },
    evalOwner: 'observer_sidecar_eval',
    authoritative: false,
    nonAuthoritativeNotice: 'non-authoritative',
  };
}
