import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import {
  accumulateSocialDesireSignal,
  type SocialDesire,
} from '../intention/social-desire.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
} from '../intention/social-desire-store-port.js';
import {
  createSocialDesireConsentLedger,
  type SocialDesireConsentEvaluator,
  type SocialDesireOutreachDeps,
} from '../intention/social-desire-outreach.js';
import {
  DEFAULT_SOCIAL_DESIRE_CONFIG,
  type SocialDesireConfig,
} from '../../system/config/scheduler-config.js';
import {
  registerSocialDesireOutreachTask,
  runSocialDesireOutreachTick,
  SOCIAL_DESIRE_OUTREACH_TASK_ID,
} from './social-desire-outreach-lane.js';
import { Scheduler } from './scheduler.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-06T15:00:00.000Z');
const LIFECYCLE = DEFAULT_SOCIAL_DESIRE_CONFIG.lifecycle;

function laneConfig(enabled: boolean): SocialDesireConfig {
  return {
    ...DEFAULT_SOCIAL_DESIRE_CONFIG,
    enabled,
    outreach: {
      ...DEFAULT_SOCIAL_DESIRE_CONFIG.outreach,
      budget: { ...DEFAULT_SOCIAL_DESIRE_CONFIG.outreach.budget },
    },
  };
}

function eligibleDesire(contactId = 'contact-1'): SocialDesire {
  let desire: SocialDesire | null = null;
  for (const offset of [-64 * HOUR, -56 * HOUR, -48 * HOUR, -40 * HOUR, -32 * HOUR, -24 * HOUR, -16 * HOUR]) {
    desire = accumulateSocialDesireSignal(
      desire,
      { contactId, orientation: 'warm', intensity: 1 },
      'partner',
      LIFECYCLE,
      T0 + offset,
    ).desire;
  }
  if (!desire) throw new Error('expected desire to accumulate');
  return desire;
}

function makeDeps(
  consentEvaluator: SocialDesireConsentEvaluator,
  desires: SocialDesire[] = [eligibleDesire()],
): SocialDesireOutreachDeps {
  return {
    store: createSocialDesireStorePort(createInMemorySocialDesireBackend(desires)),
    lifecycle: LIFECYCLE,
    tierSource: { resolveRelationshipTier: async () => 'partner' },
    consentEvaluator,
    consents: createSocialDesireConsentLedger({ ttlMs: 30 * 60 * 1000 }),
    maxConsentMomentsPerRun: 1,
    resolveDeliveryChannel: async () => ({
      channelId: 'dm-primary',
      channelType: 'discord',
      companionTarget: false,
    }),
    isBudgetExhausted: () => false,
  };
}

describe('registerSocialDesireOutreachTask', () => {
  it('never registers the lane while socialDesire.enabled is false (fail closed)', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    registerSocialDesireOutreachTask({
      scheduler,
      eventBus,
      config: laneConfig(false),
      deps: makeDeps({ evaluate: vi.fn() }),
      postTurnActions: { enqueue: vi.fn(() => 'queued' as const) },
    });
    expect(scheduler.getTask(SOCIAL_DESIRE_OUTREACH_TASK_ID)).toBeUndefined();
  });

  it('registers the lane exactly once when enabled', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const options = {
      scheduler,
      eventBus,
      config: laneConfig(true),
      deps: makeDeps({ evaluate: vi.fn() }),
      postTurnActions: { enqueue: vi.fn(() => 'queued' as const) },
    };
    registerSocialDesireOutreachTask(options);
    registerSocialDesireOutreachTask(options);
    expect(scheduler.getTask(SOCIAL_DESIRE_OUTREACH_TASK_ID)).toBeDefined();
  });
});

describe('runSocialDesireOutreachTick', () => {
  it('persists an accepted consent directly through the post-turn action runtime', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const accepted: unknown[] = [];
    eventBus.on('social_desire.consent.accepted', async (payload) => { accepted.push(payload); });
    const enqueued: InferredPostTurnAction[] = [];

    await runSocialDesireOutreachTick({
      scheduler,
      eventBus,
      config: laneConfig(true),
      deps: makeDeps({
        evaluate: vi.fn(async () => ({ action: 'message' as const, content: 'thinking of you' })),
      }),
      postTurnActions: { enqueue: (action) => { enqueued.push(action); return 'queued'; } },
    }, T0);

    expect(accepted).toEqual([
      expect.objectContaining({
        contactId: 'contact-1',
        orientation: 'warm',
        channelId: 'dm-primary',
        companionTarget: false,
      }),
    ]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toMatchObject({
      reason: 'social_desire:warm',
      socialDesire: expect.objectContaining({ contactId: 'contact-1' }),
    });
  });

  it('propagates durable enqueue failure without reporting acceptance or leaving consent live', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const accepted: unknown[] = [];
    eventBus.on('social_desire.consent.accepted', async (payload) => { accepted.push(payload); });
    const deps = makeDeps({
      evaluate: vi.fn(async () => ({ action: 'message' as const, content: 'thinking of you' })),
    });

    await expect(runSocialDesireOutreachTick({
      scheduler,
      eventBus,
      config: laneConfig(true),
      deps,
      postTurnActions: { enqueue: () => { throw new Error('queue persistence failed'); } },
    }, T0)).rejects.toThrow('queue persistence failed');

    expect(accepted).toEqual([]);
    expect(deps.consents.hasLiveConsentForContact('contact-1', T0 + 1)).toBe(false);
  });

  it('emits deferral telemetry and no actions when she defers', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const inferred: unknown[] = [];
    const deferred: unknown[] = [];
    eventBus.on('agent.post_turn.actions.inferred', async (payload) => { inferred.push(payload); });
    eventBus.on('social_desire.consent.deferred', async (payload) => { deferred.push(payload); });

    await runSocialDesireOutreachTick({
      scheduler,
      eventBus,
      config: laneConfig(true),
      deps: makeDeps({
        evaluate: vi.fn(async () => ({ action: 'defer' as const, reason: 'not now' })),
      }),
      postTurnActions: { enqueue: vi.fn(() => 'queued' as const) },
    }, T0);

    expect(inferred).toHaveLength(0);
    expect(deferred).toEqual([
      expect.objectContaining({ contactId: 'contact-1', reason: 'not now' }),
    ]);
  });

  it('emits a structured budget block and keeps the lane silent otherwise', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const blocked: unknown[] = [];
    const inferred: unknown[] = [];
    eventBus.on('social_desire.consent.blocked', async (payload) => { blocked.push(payload); });
    eventBus.on('agent.post_turn.actions.inferred', async (payload) => { inferred.push(payload); });

    const evaluate = vi.fn();
    const deps = makeDeps({ evaluate });
    await runSocialDesireOutreachTick({
      scheduler,
      eventBus,
      config: laneConfig(true),
      deps: { ...deps, isBudgetExhausted: () => true },
      postTurnActions: { enqueue: vi.fn(() => 'queued' as const) },
    }, T0);

    expect(evaluate).not.toHaveBeenCalled();
    expect(inferred).toHaveLength(0);
    expect(blocked).toEqual([
      expect.objectContaining({ contactId: 'contact-1', reason: 'budget_exhausted' }),
    ]);
  });
});
