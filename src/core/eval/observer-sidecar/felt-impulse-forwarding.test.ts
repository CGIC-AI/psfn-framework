// ── Lever stage → felt-impulse forwarding (psfn-framework-hrmrq.34, D4) ──
// A fired would_message lever must reach the affect-driven ICP initiation
// seam; other levers must not, and the lever store stays eval-owned telemetry.

import { describe, expect, it, vi } from 'vitest';
import { createDefaultObserverEvalSidecarLeverSettings } from '../../../system/config/runtime-config-contracts.js';
import { ObserverEvalLeverStage } from './config.js';
import type {
  ObserverEvalSidecarLeverPersistencePort,
} from './persistence.js';

const NOW_MS = 1_780_000_000_000;
const MINUTE_MS = 60_000;

function makeLeverPersistence(): ObserverEvalSidecarLeverPersistencePort {
  return {
    recordLeverEvent: vi.fn(async input => ({ ...input, retention: input.retention })) as never,
    queryLeverEvents: vi.fn(async () => []),
    loadLeverState: vi.fn(async () => []),
    saveLeverState: vi.fn(async () => undefined),
    pruneExpiredLeverEvents: vi.fn(async () => ({ prunedEventIds: [] })),
  } as unknown as ObserverEvalSidecarLeverPersistencePort;
}

function lonelySnapshot() {
  return {
    t: 0,
    mood: { valence: 0.2, arousal: 0.1 },
    dominant: 'Calmness',
    emotions: { Calmness: 0.3 },
    drives: { socialNeed: 0.8, sleepPressure: 0.2 },
  };
}

describe('would_message lever forwards to the felt-impulse seam', () => {
  it('emits exactly one felt-impulse signal per fire, with the fire timestamps', async () => {
    const persistence = makeLeverPersistence();
    const emitFeltImpulse = vi.fn(async () => undefined);
    const stage = new ObserverEvalLeverStage({
      settings: { ...createDefaultObserverEvalSidecarLeverSettings(), enabled: true },
      persistence,
      sidecarId: 'sidecar-felt-impulse-test',
      retentionDays: 14,
      emitFeltImpulse,
    });

    const observe = (observedAtMs: number) => stage.evaluateObservation({
      runId: 'run-1',
      observationId: `obs-${observedAtMs}`,
      snapshot: lonelySnapshot(),
      observedAtMs,
    });

    // Sustain window: crossing at T0, fires after 30 minutes sustained.
    await observe(NOW_MS);
    await observe(NOW_MS + 10 * MINUTE_MS);
    expect(emitFeltImpulse).not.toHaveBeenCalled();

    await observe(NOW_MS + 30 * MINUTE_MS);
    expect(emitFeltImpulse).toHaveBeenCalledTimes(1);
    expect(emitFeltImpulse).toHaveBeenCalledWith({
      lever: 'would_message',
      firedAtMs: NOW_MS + 30 * MINUTE_MS,
      timestamp: NOW_MS + 30 * MINUTE_MS,
    });

    // Cooldown: still met minutes later, no second impulse.
    await observe(NOW_MS + 35 * MINUTE_MS);
    expect(emitFeltImpulse).toHaveBeenCalledTimes(1);
  });

  it('does not forward non-message levers', async () => {
    const persistence = makeLeverPersistence();
    const emitFeltImpulse = vi.fn(async () => undefined);
    const stage = new ObserverEvalLeverStage({
      settings: { ...createDefaultObserverEvalSidecarLeverSettings(), enabled: true },
      persistence,
      sidecarId: 'sidecar-felt-impulse-test',
      retentionDays: 14,
      emitFeltImpulse,
    });

    // Sustained high arousal fires would_rest, not would_message.
    const restless = {
      t: 0,
      mood: { valence: 0.1, arousal: 0.9 },
      dominant: 'Calmness',
      emotions: { Calmness: 0.3 },
      drives: { socialNeed: 0.1, sleepPressure: 0.2 },
    };
    await stage.evaluateObservation({
      runId: 'run-2', observationId: 'obs-a', snapshot: restless, observedAtMs: NOW_MS,
    });
    await stage.evaluateObservation({
      runId: 'run-2', observationId: 'obs-b', snapshot: restless, observedAtMs: NOW_MS + 60 * MINUTE_MS,
    });
    expect(emitFeltImpulse).not.toHaveBeenCalled();
  });
});
