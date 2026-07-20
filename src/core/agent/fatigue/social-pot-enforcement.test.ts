import { describe, expect, it } from 'vitest';

import type { FatigueSocialPotConfig } from '../../../shared/contracts/charge-policy.js';
import {
  enforceSocialPotDraw,
  type SocialPotDrawLane,
} from './social-pot-enforcement.js';
import type {
  SocialPotDrawInput,
  SocialPotDrawResult,
  SocialPotPort,
  SocialPotSnapshot,
} from './social-pot.js';

const COMPANION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CONFIG: FatigueSocialPotConfig = {
  capUnits: 24,
  perChannelDrawFraction: 0.34,
  regenerationTickMs: 60 * 60_000,
  regenerationUnitsPerTick: 1,
};

function snapshot(balance: number, revision: number): SocialPotSnapshot {
  return {
    companionId: COMPANION,
    balance,
    cap: CONFIG.capUnits,
    lastRegenAtMs: 0,
    revision,
  };
}

/** A fake port that records the exact draw input and returns a scripted result. */
function fakePort(
  result: (input: SocialPotDrawInput) => SocialPotDrawResult,
): { port: Pick<SocialPotPort, 'draw'>; calls: SocialPotDrawInput[] } {
  const calls: SocialPotDrawInput[] = [];
  return {
    calls,
    port: {
      draw: async (input) => {
        calls.push(input);
        return result(input);
      },
    },
  };
}

function drawnResult(amount: number, before: number): SocialPotDrawResult {
  return {
    outcome: 'drawn',
    drawn: amount,
    before: snapshot(before, 1),
    after: snapshot(before - amount, 2),
  };
}

describe('enforceSocialPotDraw — human-uncharged invariant', () => {
  it('never touches the store for a human-triggered turn', async () => {
    const { port, calls } = fakePort(() => {
      throw new Error('draw must not be called for a human trigger');
    });
    const decision = await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'group_social',
      triggerAuthorKind: 'human',
      amount: 3,
      nowMs: 0,
    });
    expect(decision.outcome).toBe('uncharged');
    expect(decision.unchargedReason).toBe('human_triggered');
    expect(decision.drawn).toBe(0);
    expect(decision.before).toBeUndefined();
    expect(decision.after).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('never touches the store for an ICP lane with a human trigger either', async () => {
    const { port, calls } = fakePort(() => {
      throw new Error('draw must not be called for a human trigger');
    });
    const decision = await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'icp_continuation',
      triggerAuthorKind: 'human',
      amount: 10,
      nowMs: 0,
    });
    expect(decision.outcome).toBe('uncharged');
    expect(decision.unchargedReason).toBe('human_triggered');
    expect(calls).toHaveLength(0);
  });

  it.each(['system', 'unknown'] as const)(
    'refuses to charge a %s-triggered turn (non-autonomous)',
    async (triggerAuthorKind) => {
      const { port, calls } = fakePort(() => {
        throw new Error('draw must not be called for a non-autonomous trigger');
      });
      const decision = await enforceSocialPotDraw(port, CONFIG, {
        companionId: COMPANION,
        lane: 'group_social',
        triggerAuthorKind,
        amount: 3,
        nowMs: 0,
      });
      expect(decision.outcome).toBe('uncharged');
      expect(decision.unchargedReason).toBe('non_autonomous_trigger');
      expect(calls).toHaveLength(0);
    },
  );
});

describe('enforceSocialPotDraw — per-channel cap vs ICP priority', () => {
  it('applies the per-channel fraction cap to group-social draws', async () => {
    const { port, calls } = fakePort((input) => drawnResult(input.amount, 24));
    await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'group_social',
      triggerAuthorKind: 'machine_intelligence',
      amount: 3,
      nowMs: 1_000,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.maxDrawFraction).toBe(CONFIG.perChannelDrawFraction);
    expect(call.amount).toBe(3);
    expect(call.companionId).toBe(COMPANION);
    expect(call.nowMs).toBe(1_000);
    // Only the regeneration subset of the owner-file config reaches the store.
    expect(call.config).toEqual({
      capUnits: CONFIG.capUnits,
      regenerationTickMs: CONFIG.regenerationTickMs,
      regenerationUnitsPerTick: CONFIG.regenerationUnitsPerTick,
    });
    expect(call.config).not.toHaveProperty('perChannelDrawFraction');
  });

  it('draws ICP continuation at priority — no per-channel cap', async () => {
    const { port, calls } = fakePort((input) => drawnResult(input.amount, 24));
    await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'icp_continuation',
      triggerAuthorKind: 'machine_intelligence',
      amount: 20,
      nowMs: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].maxDrawFraction).toBeUndefined();
    expect(calls[0].amount).toBe(20);
  });

  it('passes a capped store outcome through with no spend', async () => {
    const { port } = fakePort(() => ({
      outcome: 'capped',
      drawn: 0,
      before: snapshot(24, 1),
      after: snapshot(24, 1),
    }));
    const decision = await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'group_social',
      triggerAuthorKind: 'machine_intelligence',
      amount: 20,
      nowMs: 0,
    });
    expect(decision.outcome).toBe('capped');
    expect(decision.drawn).toBe(0);
    expect(decision.before?.balance).toBe(24);
    expect(decision.after?.balance).toBe(24);
  });

  it('passes an insufficient store outcome through with no spend', async () => {
    const { port } = fakePort(() => ({
      outcome: 'insufficient',
      drawn: 0,
      before: snapshot(2, 5),
      after: snapshot(2, 5),
    }));
    const decision = await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'icp_continuation',
      triggerAuthorKind: 'machine_intelligence',
      amount: 10,
      nowMs: 0,
    });
    expect(decision.outcome).toBe('insufficient');
    expect(decision.drawn).toBe(0);
  });

  it('reports a successful draw amount and snapshots', async () => {
    const { port } = fakePort((input) => drawnResult(input.amount, 24));
    const decision = await enforceSocialPotDraw(port, CONFIG, {
      companionId: COMPANION,
      lane: 'group_social',
      triggerAuthorKind: 'machine_intelligence',
      amount: 5,
      nowMs: 0,
    });
    expect(decision.outcome).toBe('drawn');
    expect(decision.drawn).toBe(5);
    expect(decision.before?.balance).toBe(24);
    expect(decision.after?.balance).toBe(19);
  });
});

describe('enforceSocialPotDraw — fail closed on bad input', () => {
  it('throws on an unknown lane rather than silently spending', async () => {
    const { port, calls } = fakePort(() => drawnResult(1, 24));
    await expect(
      enforceSocialPotDraw(port, CONFIG, {
        companionId: COMPANION,
        lane: 'broadcast' as unknown as SocialPotDrawLane,
        triggerAuthorKind: 'machine_intelligence',
        amount: 1,
        nowMs: 0,
      }),
    ).rejects.toThrow(/not a known lane/);
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws on a non-positive/non-finite amount (%s)',
    async (amount) => {
      const { port, calls } = fakePort(() => drawnResult(1, 24));
      await expect(
        enforceSocialPotDraw(port, CONFIG, {
          companionId: COMPANION,
          lane: 'group_social',
          triggerAuthorKind: 'machine_intelligence',
          amount,
          nowMs: 0,
        }),
      ).rejects.toThrow(/amount must be a finite number > 0/);
      expect(calls).toHaveLength(0);
    },
  );
});
