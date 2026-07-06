import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultObserverEvalSidecarLeverSettings,
  createDefaultObserverEvalSidecarSettings,
} from '../../../system/config/runtime-config-contracts.js';
import {
  createObserverEvalSidecarRuntimeFromConfig,
  ObserverEvalLeverStage,
  shouldPropagateObserverEvalObservationError,
  toObserverEvalPersistenceDeployment,
} from './config.js';
import type {
  ObserverEvalSidecarLeverEventInput,
  ObserverEvalSidecarLeverEventRecord,
  ObserverEvalSidecarLeverPersistencePort,
  ObserverEvalSidecarLeverStateEntry,
} from './persistence.js';
import type { ObserverLeverSnapshotInput } from './levers.js';
import type { ObserverEvalInputPayload } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('createObserverEvalSidecarRuntimeFromConfig', () => {
  it('keeps the observer detached when the sidecar is disabled', () => {
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    });

    expect(runtime.config?.enabled).toBe(false);
    expect(runtime.observer).toBeNull();
  });

  it('attaches an EmoSim observer for enabled sidecar settings', async () => {
    const emoSimRoot = mkdtempSync(join(tmpdir(), 'psfn-emosim-missing-'));
    tempDirs.push(emoSimRoot);
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: {
        ...createDefaultObserverEvalSidecarSettings(),
        enabled: true,
        adapter: {
          kind: 'emosim',
          emosimRoot: emoSimRoot,
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
      'EmoSim statemashine.py was not found',
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

class FakeLeverPersistence implements ObserverEvalSidecarLeverPersistencePort {
  readonly events: ObserverEvalSidecarLeverEventInput[] = [];
  savedStates: ObserverEvalSidecarLeverStateEntry[][] = [];
  failOnRecord = false;

  async recordLeverEvent(input: ObserverEvalSidecarLeverEventInput): Promise<ObserverEvalSidecarLeverEventRecord> {
    if (this.failOnRecord) {
      throw new Error('lever persistence exploded');
    }
    this.events.push(input);
    return input as unknown as ObserverEvalSidecarLeverEventRecord;
  }

  async queryLeverEvents(): Promise<ObserverEvalSidecarLeverEventRecord[]> {
    return [];
  }

  async loadLeverState(): Promise<ObserverEvalSidecarLeverStateEntry[]> {
    return [];
  }

  async saveLeverState(input: {
    sidecarId: string;
    updatedAtMs: number;
    entries: readonly ObserverEvalSidecarLeverStateEntry[];
  }): Promise<void> {
    this.savedStates.push([...input.entries]);
  }

  async pruneExpiredLeverEvents(nowMs: number) {
    return { prunedAtMs: nowMs, prunedEventIds: [] as const };
  }
}

function makeLeverSnapshot(socialNeed: number): ObserverLeverSnapshotInput {
  return {
    t: 0,
    mood: { valence: 0.2, arousal: 0.1 },
    dominant: 'Calmness',
    emotions: { Calmness: 0.3 },
    drives: { socialNeed, sleepPressure: 0.1 },
  };
}

describe('ObserverEvalLeverStage', () => {
  const NOW = 1_780_000_000_000;

  function makeStage(persistence: FakeLeverPersistence) {
    return new ObserverEvalLeverStage({
      settings: { ...createDefaultObserverEvalSidecarLeverSettings(), enabled: true },
      persistence,
      sidecarId: 'sidecar-test',
      retentionDays: 14,
    });
  }

  it('records WOULD-ACT events with >= 90 day retention and persists tracker state', async () => {
    const persistence = new FakeLeverPersistence();
    const stage = makeStage(persistence);

    await stage.evaluateObservation({
      runId: 'run-1',
      observationId: 'obs-1',
      snapshot: makeLeverSnapshot(0.9),
      observedAtMs: NOW,
    });
    await stage.evaluateObservation({
      runId: 'run-1',
      observationId: 'obs-2',
      snapshot: makeLeverSnapshot(0.9),
      observedAtMs: NOW + 30 * 60_000,
    });

    expect(persistence.events.map(event => event.lever)).toEqual(['would_message']);
    const event = persistence.events[0]!;
    expect(event.observationId).toBe('obs-2');
    expect(event.firstCrossingMs).toBe(NOW);
    expect(event.retention.retainUntilMs - event.firedAtMs).toBeGreaterThanOrEqual(90 * 86_400_000);
    expect(persistence.savedStates.length).toBe(2);
  });

  it('never propagates lever failures into the observation path, but records them', async () => {
    const persistence = new FakeLeverPersistence();
    persistence.failOnRecord = true;
    const stage = makeStage(persistence);

    await stage.evaluateObservation({
      runId: 'run-1',
      observationId: 'obs-1',
      snapshot: makeLeverSnapshot(0.9),
      observedAtMs: NOW,
    });
    // Second call would fire an event; recordLeverEvent throws.
    await expect(stage.evaluateObservation({
      runId: 'run-1',
      observationId: 'obs-2',
      snapshot: makeLeverSnapshot(0.9),
      observedAtMs: NOW + 30 * 60_000,
    })).resolves.toBeUndefined();

    const lastStates = persistence.savedStates.at(-1)!;
    const errored = lastStates.find(entry => {
      const lastEvaluation = entry.state.lastEvaluation as { error?: string } | undefined;
      return Boolean(lastEvaluation?.error);
    });
    expect(errored).toBeDefined();
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
