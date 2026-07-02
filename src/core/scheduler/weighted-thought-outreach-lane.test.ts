import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import {
  runWeightedThoughtOutreachTick,
  type WeightedThoughtOutreachTaskOptions,
} from './weighted-thought-outreach-lane.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
} from '../intention/weighted-thought-store-port.js';
import {
  createThoughtWeight,
  type WeightedThoughtLifecycleConfig,
} from '../intention/weighted-thoughts.js';
import type { NudgeEvaluator } from '../intention/weighted-thought-outreach.js';
import type { WeightedThoughtOutreachConfig } from '../../system/config/scheduler-config.js';
import type { Scheduler } from './scheduler.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-02T15:00:00.000Z');

const LIFECYCLE: WeightedThoughtLifecycleConfig = {
  classes: {
    time_sensitive: { baseWeight: 0.5, halflifeMs: 6 * HOUR },
    standard: { baseWeight: 0.4, halflifeMs: 24 * HOUR },
    trivial: { baseWeight: 0.2, halflifeMs: 72 * HOUR },
  },
  reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
  accumulatedWeightCap: 3,
  contradictionDampeningFactor: 0.6,
  declineDampeningFactor: 0.5,
  relevanceFloor: 0.05,
};

const CONFIG: WeightedThoughtOutreachConfig = {
  enabled: true,
  checkIntervalMs: 300_000,
  nudgeThreshold: 0.5,
  maxNudgesPerRun: 1,
  lifecycle: LIFECYCLE,
};

function buildOptions(
  store: WeightedThoughtOutreachTaskOptions['store'],
  eventBus: EventBus,
  nudgeEvaluator: NudgeEvaluator,
): WeightedThoughtOutreachTaskOptions {
  return {
    scheduler: {} as unknown as Scheduler, // unused by runWeightedThoughtOutreachTick
    eventBus,
    config: CONFIG,
    store,
    nudgeEvaluator,
    channelPolicy: { primaryChannelId: 'dm-primary', primaryChannelType: 'discord' },
  };
}

describe('weighted-thought outreach lane', () => {
  it('emits an open gate event and enqueues an outbound action on accept', async () => {
    const store = createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend([
      createThoughtWeight(
        {
          id: 'wt-1',
          content: 'check in',
          source: 'concern',
          thoughtClass: 'standard',
          emotionalIntensity: 1,
          provenance: { concernId: 'concern-1' },
        },
        LIFECYCLE,
        T0,
      ),
    ]));
    const eventBus = new EventBus();
    const gate: unknown[] = [];
    const produced: unknown[] = [];
    const accepted: unknown[] = [];
    const inferred: Array<{ actions: Array<{ kind: string; payload: Record<string, unknown> }> }> = [];
    eventBus.on('intention.nudge.gate', (e) => { gate.push(e); });
    eventBus.on('intention.nudge.produced', (e) => { produced.push(e); });
    eventBus.on('intention.nudge.accepted', (e) => { accepted.push(e); });
    eventBus.on('agent.post_turn.actions.inferred', (e) => {
      inferred.push(e as { actions: Array<{ kind: string; payload: Record<string, unknown> }> });
    });

    const evaluator: NudgeEvaluator = { evaluate: async () => ({ action: 'accept', content: 'hey you' }) };
    await runWeightedThoughtOutreachTick(buildOptions(store, eventBus, evaluator), T0);

    expect(gate).toHaveLength(1);
    expect((gate[0] as { open: boolean }).open).toBe(true);
    expect(produced).toHaveLength(1);
    expect(accepted).toHaveLength(1);
    expect(inferred).toHaveLength(1);
    const action = inferred[0]!.actions[0]!;
    expect(action.kind).toBe('intention.outbound_message');
    expect(action.payload.concernIds).toEqual(['concern-1']);
    expect(action.payload.channelId).toBe('dm-primary');
  });

  it('emits only a closed gate event when nothing is near threshold', async () => {
    const store = createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend([
      createThoughtWeight(
        { id: 'wt-weak', content: 'x', source: 'concern', thoughtClass: 'trivial', provenance: { concernId: 'c' } },
        LIFECYCLE,
        T0,
      ),
    ]));
    const eventBus = new EventBus();
    let gateEvent: { open: boolean } | undefined;
    let inferredCount = 0;
    eventBus.on('intention.nudge.gate', (e) => { gateEvent = e as { open: boolean }; });
    eventBus.on('agent.post_turn.actions.inferred', () => { inferredCount += 1; });

    let nudgeCalls = 0;
    const evaluator: NudgeEvaluator = {
      evaluate: async () => { nudgeCalls += 1; return { action: 'decline' }; },
    };
    await runWeightedThoughtOutreachTick(buildOptions(store, eventBus, evaluator), T0);

    expect(gateEvent?.open).toBe(false);
    expect(inferredCount).toBe(0);
    expect(nudgeCalls).toBe(0); // zero LLM
  });
});
