import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { createDefaultEmoSimProactivitySettings } from '../../../system/config/runtime-config-contracts.js';
import { createEmoSimProactivityPort, type EmoSimProactivityState } from '../../emotion/emosim-proactivity-port.js';
import { registerEmoSimProactivitySampling } from '../../scheduler/emosim-proactivity-lane.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { EMOSIM_EMOTION_VECTOR, EMOSIM_SNAPSHOT_FORMAT, type EmoSimEngineSnapshot } from './emosim-adapter.js';
import { createEmoSimLiveStateSampler } from './proactivity-sampling.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const START = 1_800_000_000_000;
const MINUTE = 60_000;

function harness() {
  let now = START;
  let t = 1;
  let sessionId = 'session-1';
  let state: EmoSimProactivityState = {
    firstCrossingMs: null, lastFiredAtMs: null, lastSampledAtMs: null, lastInputId: null,
  };
  const emitImpulse = vi.fn(async () => {});
  const profile = createDefaultEmoSimProactivitySettings().thresholdProfile;
  const port = createEmoSimProactivityPort({
    enabled: true, companionId: COMPANION_ID,
    thresholdProfile: { ...profile, samplingIntervalMs: MINUTE, sustainMs: 2 * MINUTE },
    stateStore: {
      load: async () => structuredClone(state),
      save: async next => { state = structuredClone(next); },
    },
    emitImpulse,
  });
  const snapshot = (): EmoSimEngineSnapshot => ({
    format: EMOSIM_SNAPSHOT_FORMAT, t, dominant: 'Calmness',
    mood: { valence: 0, arousal: 0 },
    emotions: Object.fromEntries(EMOSIM_EMOTION_VECTOR.map(name => [name, 0])),
    drives: {
      socialNeed: 0.9, hunger: 0, thirst: 0, sleepPressure: 0, stimulationNeed: 0,
      esteemNeed: 0, insecurity: 0, health: 1, asleep: 0,
    },
  });
  const readCurrentState = vi.fn(async () => ({ sessionId, snapshot: snapshot() }));
  const sample = createEmoSimLiveStateSampler({
    companionId: COMPANION_ID, port, readCurrentState, now: () => now,
  });
  return {
    sample, emitImpulse, readCurrentState, state: () => state, now: () => now,
    restartSampler: () => createEmoSimLiveStateSampler({
      companionId: COMPANION_ID, port, readCurrentState, now: () => now,
    }),
    advance: (nextT: number, nextSession = sessionId) => {
      now += MINUTE; t = nextT; sessionId = nextSession;
    },
  };
}

describe('independent EmoSim live-state observation', () => {
  it('uses the real scheduler and production port to emit after fresh sustained state without a turn', async () => {
    const h = harness();
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const runtime = { proactivitySampling: { intervalMs: MINUTE, sample: h.sample } };
    registerEmoSimProactivitySampling(scheduler, runtime);
    registerEmoSimProactivitySampling(scheduler, runtime);
    const task = scheduler.getTask('emotion.emosim-live-state')!;
    expect(task.intervalMs).toBe(MINUTE);
    const clock = vi.spyOn(Date, 'now').mockImplementation(h.now);
    try {
      await scheduler.tick();
      expect(h.state().firstCrossingMs).toBeNull();
      for (const t of [2, 3, 4]) { h.advance(t); await scheduler.tick(); }
    } finally {
      clock.mockRestore();
    }
    expect(h.emitImpulse).toHaveBeenCalledTimes(1);
    expect(h.emitImpulse).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID, kind: 'would_message',
      lineage: expect.objectContaining({ inputId: 'emosim-live-state:session-1:4', rawContentRedacted: true }),
    }));
  });

  it.each(['frozen', 'regressed', 'replaced'] as const)('resets sustain for a %s source clock', async kind => {
    const h = harness();
    await h.sample();
    h.advance(2); await h.sample();
    expect(h.state().firstCrossingMs).not.toBeNull();
    h.advance(kind === 'regressed' ? 1 : 2, kind === 'replaced' ? 'session-2' : 'session-1');
    await h.sample();
    expect(h.state().firstCrossingMs).toBeNull();
    h.advance(3); await h.sample();
    expect(h.emitImpulse).not.toHaveBeenCalled();
  });

  it('surfaces read failure and requires a fresh clock baseline after recovery', async () => {
    const h = harness();
    await h.sample();
    h.advance(2); await h.sample();
    h.advance(3);
    h.readCurrentState.mockRejectedValueOnce(new Error('source offline'));
    await expect(h.sample()).rejects.toThrow('source offline');
    expect(h.state().firstCrossingMs).toBeNull();
    h.advance(4); await h.sample();
    expect(h.state().firstCrossingMs).toBeNull();
    expect(h.emitImpulse).not.toHaveBeenCalled();
  });

  it('invalidates a persisted crossing on restart even inside the sampling window', async () => {
    const h = harness();
    await h.sample();
    h.advance(2); await h.sample();
    expect(h.state().firstCrossingMs).not.toBeNull();
    const restarted = h.restartSampler();
    // No wall time elapsed: availability invalidation still beats dedupe.
    await restarted();
    expect(h.state().firstCrossingMs).toBeNull();
    expect(h.emitImpulse).not.toHaveBeenCalled();
  });

  it('does not register without an enabled source sampler', () => {
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    registerEmoSimProactivitySampling(scheduler, {});
    expect(scheduler.getTask('emotion.emosim-live-state')).toBeUndefined();
  });
});
