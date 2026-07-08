import { describe, expect, it, vi } from 'vitest';
import {
  buildOutboundActionCandidate,
  resolveOutreachChannel,
  runWeightedThoughtOutreachOnce,
  type NudgeEvaluator,
  type OutreachChannelPolicy,
  type WeightedThoughtOutreachDeps,
} from './weighted-thought-outreach.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
  type WeightedThoughtStorePort,
} from './weighted-thought-store-port.js';
import {
  createThoughtWeight,
  type ThoughtWeight,
  type WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';
import { ProactiveOutboundDispatcher } from './proactive-outbound.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import type { ProactiveQuietHoursConfig } from './proactive-time-gate.js';

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

const PRIMARY_POLICY: OutreachChannelPolicy = {
  primaryChannelId: 'dm-primary',
  primaryChannelType: 'discord',
};

function makeStore(...thoughts: ThoughtWeight[]): WeightedThoughtStorePort {
  return createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend(thoughts));
}

function acceptEvaluator(content = 'hey, thinking of you'): NudgeEvaluator {
  return { evaluate: vi.fn(async () => ({ action: 'accept' as const, content })) };
}

function declineEvaluator(reason = 'not the right moment'): NudgeEvaluator {
  return { evaluate: vi.fn(async () => ({ action: 'decline' as const, reason })) };
}

function baseDeps(
  store: WeightedThoughtStorePort,
  nudgeEvaluator: NudgeEvaluator,
  overrides: Partial<WeightedThoughtOutreachDeps> = {},
): WeightedThoughtOutreachDeps {
  return {
    store,
    lifecycleConfig: LIFECYCLE,
    nudgeThreshold: 0.5,
    maxNudgesPerRun: 1,
    channelPolicy: PRIMARY_POLICY,
    nudgeEvaluator,
    ...overrides,
  };
}

// A strong (above-threshold) standard thought with live concern provenance.
function strongThought(id = 'wt-strong'): ThoughtWeight {
  return createThoughtWeight(
    {
      id,
      content: 'check in on V',
      source: 'concern',
      thoughtClass: 'standard',
      emotionalIntensity: 1, // 0.4 * (1+1) = 0.8 > 0.5 threshold
      provenance: { concernId: 'concern-1' },
    },
    LIFECYCLE,
    T0,
  );
}

describe('weighted-thought outreach initiation', () => {
  it('is a zero-LLM no-op when no thought is near threshold (gate closed)', async () => {
    const weak = createThoughtWeight(
      { id: 'wt-weak', content: 'x', source: 'concern', thoughtClass: 'trivial', provenance: { concernId: 'c' } },
      LIFECYCLE,
      T0,
    );
    const evaluator = acceptEvaluator();
    const result = await runWeightedThoughtOutreachOnce(baseDeps(makeStore(weak), evaluator), T0);
    expect(result.gate.open).toBe(false);
    expect(result.evaluated).toBe(false);
    expect(result.nudgesEvaluated).toBe(0);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(result.produced).toHaveLength(0);
  });

  it('accepted nudge produces an outbound action carrying concern provenance and marks the thought accepted', async () => {
    const store = makeStore(strongThought());
    const evaluator = acceptEvaluator('hey, been thinking about you');
    const result = await runWeightedThoughtOutreachOnce(baseDeps(store, evaluator), T0);

    expect(result.gate.open).toBe(true);
    expect(result.nudgesEvaluated).toBe(1);
    expect(result.produced).toHaveLength(1);
    const produced = result.produced[0]!;
    expect(produced.channelId).toBe('dm-primary');
    expect(produced.target).toBe('primary');
    const payload = produced.candidate.payload as Record<string, unknown>;
    expect(payload.concernIds).toEqual(['concern-1']);
    expect(payload.content).toBe('hey, been thinking about you');

    // Thought is now accepted and no longer in the active snapshot.
    expect(store.snapshotActiveThoughts()).toHaveLength(0);
    const persisted = await store.getById('wt-strong');
    expect(persisted!.nudgeState).toBe('accepted');
  });

  it('produced action flows through the existing dispatcher policy gates (approve + deny)', async () => {
    const store = makeStore(strongThought());
    const result = await runWeightedThoughtOutreachOnce(baseDeps(store, acceptEvaluator('ping')), T0);
    const payload = result.produced[0]!.candidate.payload as {
      channelId: string;
      channelType: 'discord';
      content: string;
    };

    const sent: Array<{ channelId: string; content: string }> = [];
    const sender = { send: async (channelId: string, content: string) => { sent.push({ channelId, content }); } };

    // Approving policy -> sent.
    const approving = new ProactiveOutboundDispatcher({
      sender,
      rateLimiter: new ExternalCommunicationRateLimiter(),
      isApprovedPrimaryChannel: (id) => id === 'dm-primary',
    });
    const okResult = await approving.dispatch({
      actionId: 'a1',
      channelId: payload.channelId,
      channelType: payload.channelType,
      content: payload.content,
    });
    expect(okResult.outcome).toBe('sent');
    expect(sent).toHaveLength(1);

    // Denying policy -> blocked, nothing sent.
    const denying = new ProactiveOutboundDispatcher({
      sender,
      rateLimiter: new ExternalCommunicationRateLimiter(),
      isApprovedPrimaryChannel: () => false,
    });
    const blockedResult = await denying.dispatch({
      actionId: 'a2',
      channelId: payload.channelId,
      channelType: payload.channelType,
      content: payload.content,
    });
    expect(blockedResult.outcome).toBe('blocked');
    if (blockedResult.outcome === 'blocked') {
      expect(blockedResult.reason).toBe('channel_not_approved_for_primary');
    }
    expect(sent).toHaveLength(1); // unchanged
  });

  it('declined nudge dampens the weight (not zero) and defers via nudgeState', async () => {
    const store = makeStore(strongThought());
    const before = (await store.getById('wt-strong'))!.accumulatedWeight;
    const result = await runWeightedThoughtOutreachOnce(baseDeps(store, declineEvaluator()), T0);

    expect(result.produced).toHaveLength(0);
    expect(result.declined).toHaveLength(1);
    const persisted = (await store.getById('wt-strong'))!;
    expect(persisted.nudgeState).toBe('declined');
    expect(persisted.accumulatedWeight).toBeCloseTo(before * 0.5, 6);
    expect(persisted.accumulatedWeight).toBeGreaterThan(0);
  });

  it('persists decline dampening when an accepted nudge has blank content (no retry loop)', async () => {
    const store = makeStore(strongThought());
    const before = (await store.getById('wt-strong'))!.accumulatedWeight;
    const evaluator = acceptEvaluator('   ');
    const result = await runWeightedThoughtOutreachOnce(baseDeps(store, evaluator), T0);

    expect(result.produced).toHaveLength(0);
    expect(result.blocked).toEqual([
      { thoughtId: 'wt-strong', reason: 'empty_nudge_content', channelId: 'dm-primary' },
    ]);

    const persisted = (await store.getById('wt-strong'))!;
    expect(persisted.nudgeState).toBe('declined');
    expect(persisted.accumulatedWeight).toBeCloseTo(before * 0.5, 6);

    // The dampened thought no longer re-qualifies: the next run burns no LLM.
    const second = await runWeightedThoughtOutreachOnce(baseDeps(store, evaluator), T0);
    expect(second.nudgesEvaluated).toBe(0);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
  });

  it('respects quiet hours: defers with zero LLM', async () => {
    const quietHours: ProactiveQuietHoursConfig = {
      // T0 is 15:00 UTC — inside this window, which exits at 23:00.
      enabled: true,
      startLocalTime: '00:00',
      endLocalTime: '23:00',
      timeZone: 'UTC',
    };
    const evaluator = acceptEvaluator();
    const result = await runWeightedThoughtOutreachOnce(
      baseDeps(makeStore(strongThought()), evaluator, { quietHours }),
      T0,
    );
    expect(result.produced).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0]!.reason).toBe('quiet_hours');
    expect(evaluator.evaluate).not.toHaveBeenCalled(); // zero LLM during quiet hours
  });

  it('routes internal-only (no LLM) when a thought lacks live provenance', async () => {
    const noProvenance = createThoughtWeight(
      { id: 'wt-np', content: 'x', source: 'agent', thoughtClass: 'standard', emotionalIntensity: 1 },
      LIFECYCLE,
      T0,
    );
    const evaluator = acceptEvaluator();
    const result = await runWeightedThoughtOutreachOnce(baseDeps(makeStore(noProvenance), evaluator), T0);
    expect(result.produced).toHaveLength(0);
    expect(result.blocked).toEqual([{ thoughtId: 'wt-np', reason: 'missing_live_provenance' }]);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });
});

describe('provenance-driven group-continuation channel resolution', () => {
  const groupThought = createThoughtWeight(
    {
      id: 'wt-group',
      content: 'follow up in the group',
      source: 'concern',
      thoughtClass: 'standard',
      emotionalIntensity: 1,
      provenance: { concernId: 'concern-g', sourceChannelId: 'group-1', sourceChannelType: 'discord' },
    },
    LIFECYCLE,
    T0,
  );

  it('targets the source group ONLY when the continuation policy approves', async () => {
    const resolution = await resolveOutreachChannel(groupThought, {
      ...PRIMARY_POLICY,
      approveGroupContinuation: () => true,
    });
    expect(resolution).toEqual({
      outcome: 'deliver',
      channelId: 'group-1',
      channelType: 'discord',
      target: 'group_continuation',
    });
  });

  it('routes internal-only when group continuation is denied (fail-closed default)', async () => {
    const denied = await resolveOutreachChannel(groupThought, PRIMARY_POLICY);
    expect(denied).toEqual({ outcome: 'internal_only', reason: 'group_continuation_denied' });

    const explicitlyDenied = await resolveOutreachChannel(groupThought, {
      ...PRIMARY_POLICY,
      approveGroupContinuation: () => false,
    });
    expect(explicitlyDenied).toEqual({ outcome: 'internal_only', reason: 'group_continuation_denied' });
  });

  it('an approved group nudge produces an action targeting the group channel', async () => {
    const store = makeStore(groupThought);
    const result = await runWeightedThoughtOutreachOnce(
      baseDeps(store, acceptEvaluator('following up here'), {
        channelPolicy: { ...PRIMARY_POLICY, approveGroupContinuation: () => true },
      }),
      T0,
    );
    expect(result.produced).toHaveLength(1);
    expect(result.produced[0]!.channelId).toBe('group-1');
    expect(result.produced[0]!.target).toBe('group_continuation');
  });

  it('builds a candidate with a stable dedupe key and reason', () => {
    const candidate = buildOutboundActionCandidate({
      thought: strongThought(),
      content: 'hi',
      channelId: 'dm-primary',
      channelType: 'discord',
    });
    expect(candidate.kind).toBe('intention.outbound_message');
    expect(candidate.dedupeKey).toContain('weighted-thought:wt-strong');
    expect((candidate.payload as Record<string, unknown>).reason).toBe('weighted_thought:standard');
  });
});
