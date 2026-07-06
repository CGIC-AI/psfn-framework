import { describe, expect, it } from 'vitest';
import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import {
  createObserverEvalSidecarRuntimeFromConfig,
  shouldPropagateObserverEvalObservationError,
  toObserverEvalPersistenceDeployment,
} from './config.js';
import type { ObserverEvalInputPayload } from './types.js';

describe('createObserverEvalSidecarRuntimeFromConfig', () => {
  it('keeps the observer detached when the sidecar is disabled', () => {
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    });

    expect(runtime.config?.enabled).toBe(false);
    expect(runtime.observer).toBeNull();
  });

  it('attaches an EmoSim server observer for enabled sidecar settings', async () => {
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: {
        ...createDefaultObserverEvalSidecarSettings(),
        enabled: true,
        adapter: {
          kind: 'emosim_server',
          // Port 9 (discard) is never a live emo_sim server; the observation
          // must surface a server-unreachable failure without blocking.
          serverUrl: 'http://127.0.0.1:9',
          sessionLabel: 'psfn-observer-eval-test',
          agentName: 'observer',
          timeoutMs: 250,
          includeWorldState: false,
        },
        persistence: {
          enabled: false,
          retentionDays: 14,
          maxStoredObservations: 10_000,
        },
      },
    });

    expect(runtime.config?.enabled).toBe(true);
    expect(runtime.observer).not.toBeNull();
    await expect(runtime.observer?.observeTurn(makeObserverInput())).rejects.toThrow(
      /EmoSim server request GET \/api\/model (failed|timed out)/,
    );
  });

  it('fails closed when enabled emosim_server settings are missing required adapter fields', () => {
    expect(() => createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: {
        ...createDefaultObserverEvalSidecarSettings(),
        enabled: true,
        adapter: {
          kind: 'emosim_server',
          includeWorldState: false,
        },
      },
    })).toThrow(
      'observerEvalSidecar.adapter requires serverUrl, sessionLabel, and agentName for kind=emosim_server',
    );
  });

  it('maps test persona deployment targets to the persistence deployment label', () => {
    expect(toObserverEvalPersistenceDeployment('live')).toBe('live');
    expect(toObserverEvalPersistenceDeployment('eval')).toBe('eval');
    expect(toObserverEvalPersistenceDeployment('test_persona')).toBe('test');
    expect(toObserverEvalPersistenceDeployment(undefined)).toBe('test');
  });

  it('keeps persisted recoverable observation errors out of runtime health failures', () => {
    expect(shouldPropagateObserverEvalObservationError(undefined, true)).toBe(false);
    expect(shouldPropagateObserverEvalObservationError(makeObservationError(true), true)).toBe(false);
    expect(shouldPropagateObserverEvalObservationError(makeObservationError(true), false)).toBe(true);
    expect(shouldPropagateObserverEvalObservationError(makeObservationError(false), true)).toBe(true);
  });
});

function makeObservationError(recoverable: boolean) {
  return {
    message: 'observation unavailable',
    code: 'observation-unavailable',
    recoverable,
    redacted: true as const,
    redactionReason: 'observer_eval_projection_error',
  };
}

function makeObserverInput(): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-1',
      requestId: 'request-1',
      sourceMessageId: 'message-1',
      channelId: 'channel-1',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: {
        vad: { valence: 0.4, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.2, arousal: 0.1, dominance: 0.05 },
        discrete: { joy: 0.5, trust: 0.2 },
        confidence: 0.8,
      },
      appraisalEntryCount: 1,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 24,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_000,
      emotionSessionId: 'emotion-session-1',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'chat',
      },
    },
  };
}
