import { describe, expect, it } from 'vitest';
import { PostgresSocialDesireStore } from './social-desire-adapter.js';
import {
  accumulateSocialDesireSignal,
  decayedSocialDesirePressure,
  type SocialDesire,
  type SocialDesireLifecycleConfig,
} from '../social-desire.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-06T12:00:00.000Z');

const CONFIG: SocialDesireLifecycleConfig = {
  baseGain: 0.15,
  pressureCap: 3,
  actionThreshold: 1,
  pressureFloor: 0.05,
  decay: { warmHalflifeMs: 72 * HOUR, repairHalflifeMs: 96 * HOUR },
  coolingOff: { warmMs: HOUR, repairMs: 12 * HOUR },
  releaseFactor: 0.25,
  dampeningFactor: 0.5,
  concernReinforcementGain: 0.3,
  maxReinforcedConcernIds: 16,
  tiers: {
    acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * HOUR },
    friend: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
    family: { gainMultiplier: 1.4, tickGapMs: 4 * HOUR },
    partner: { gainMultiplier: 2, tickGapMs: 2 * HOUR },
    ai_companion: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
  },
};

interface FakeRow {
  contact_id: string;
  warm_pressure: number;
  repair_pressure: number;
  pressure_anchor_at: string;
  last_warm_felt_at: string | null;
  last_repair_felt_at: string | null;
  last_warm_tick_at: string | null;
  last_repair_tick_at: string | null;
  tick_count: number;
  absorbed_signal_count: number;
  tier_at_last_tick: string;
  reinforced_concern_ids: string;
  created_at: string;
}

interface FakeSettlementRow {
  settlement_id: string;
  contact_id: string;
  disposition: string;
}

/**
 * Minimal fake Pool that persists social_desires rows in a shared Map so a
 * fresh store instance can hydrate from the same "durable" storage — modelling
 * the restart path (same harness shape as the weighted-thoughts adapter test).
 */
class FakeSocialDesirePool {
  private readonly settlements = new Map<string, FakeSettlementRow>();
  private failSettlementUpdateOnce: boolean;

  constructor(
    private readonly rows: Map<string, FakeRow>,
    options: { failSettlementUpdateOnce?: boolean } = {},
  ) {
    this.failSettlementUpdateOnce = options.failSettlementUpdateOnce === true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: FakeRow[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('INSERT INTO social_desires')) {
      const contactId = values[0] as string;
      const existing = this.rows.get(contactId);
      const row: FakeRow = {
        contact_id: contactId,
        warm_pressure: values[1] as number,
        repair_pressure: values[2] as number,
        pressure_anchor_at: values[3] as string,
        last_warm_felt_at: (values[4] as string | null) ?? null,
        last_repair_felt_at: (values[5] as string | null) ?? null,
        last_warm_tick_at: (values[6] as string | null) ?? null,
        last_repair_tick_at: (values[7] as string | null) ?? null,
        tick_count: values[8] as number,
        absorbed_signal_count: values[9] as number,
        tier_at_last_tick: values[10] as string,
        reinforced_concern_ids: values[11] as string,
        // ON CONFLICT keeps the original created_at (not in the update set).
        created_at: existing?.created_at ?? (values[12] as string),
      };
      this.rows.set(row.contact_id, row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT') && sql.includes('WHERE contact_id = $1')) {
      const found = this.rows.get(values[0] as string);
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith('DELETE FROM social_desires')) {
      const contactId = values[0] as string;
      const existed = this.rows.delete(contactId);
      return { rows: existed ? [{ contact_id: contactId } as unknown as FakeRow] : [] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM social_desires')) {
      // Covers both hydrateCache (no WHERE) and list().
      return { rows: [...this.rows.values()] };
    }
    throw new Error(`Unhandled SQL in FakeSocialDesirePool: ${sql}`);
  }

  async connect() {
    let txRows = new Map(this.rows);
    let txSettlements = new Map(this.settlements);
    return {
      query: async (text: string, values: readonly unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql === 'COMMIT') {
          this.rows.clear();
          for (const [id, row] of txRows) this.rows.set(id, row);
          this.settlements.clear();
          for (const [id, row] of txSettlements) this.settlements.set(id, row);
          return { rows: [] };
        }
        if (sql.startsWith('SELECT') && sql.includes('FROM social_desires') && sql.includes('FOR UPDATE')) {
          const row = txRows.get(values[0] as string);
          return { rows: row ? [row] : [] };
        }
        if (sql.startsWith('INSERT INTO social_desire_settlements')) {
          const settlementId = values[0] as string;
          if (txSettlements.has(settlementId)) return { rows: [] };
          const row: FakeSettlementRow = {
            settlement_id: settlementId,
            contact_id: values[1] as string,
            disposition: values[2] as string,
          };
          txSettlements.set(settlementId, row);
          return { rows: [row] };
        }
        if (sql.startsWith('SELECT contact_id, disposition FROM social_desire_settlements')) {
          const row = txSettlements.get(values[0] as string);
          return { rows: row ? [row] : [] };
        }
        if (sql.startsWith('UPDATE social_desires SET')) {
          if (this.failSettlementUpdateOnce) {
            this.failSettlementUpdateOnce = false;
            // The adapter's ROLLBACK discards this transaction snapshot.
            txRows = new Map(this.rows);
            txSettlements = new Map(this.settlements);
            throw new Error('injected Postgres save failure');
          }
          const existing = txRows.get(values[0] as string);
          if (!existing) return { rows: [] };
          const row: FakeRow = {
            contact_id: values[0] as string,
            warm_pressure: values[1] as number,
            repair_pressure: values[2] as number,
            pressure_anchor_at: values[3] as string,
            last_warm_felt_at: values[4] as string | null,
            last_repair_felt_at: values[5] as string | null,
            last_warm_tick_at: values[6] as string | null,
            last_repair_tick_at: values[7] as string | null,
            tick_count: values[8] as number,
            absorbed_signal_count: values[9] as number,
            tier_at_last_tick: values[10] as string,
            reinforced_concern_ids: values[11] as string,
            created_at: existing.created_at,
          };
          txRows.set(row.contact_id, row);
          return { rows: [row] };
        }
        throw new Error(`Unhandled transaction SQL in FakeSocialDesirePool: ${sql}`);
      },
      release: () => undefined,
    };
  }
}

function newStore(
  rows: Map<string, FakeRow>,
  options: { failSettlementUpdateOnce?: boolean } = {},
): PostgresSocialDesireStore {
  return new PostgresSocialDesireStore(new FakeSocialDesirePool(rows, options) as never);
}

function makeDesire(): SocialDesire {
  let desire: SocialDesire | null = null;
  desire = accumulateSocialDesireSignal(
    desire,
    { contactId: 'contact-v', orientation: 'warm', intensity: 0.8 },
    'partner',
    CONFIG,
    T0,
  ).desire;
  desire = accumulateSocialDesireSignal(
    desire,
    { contactId: 'contact-v', orientation: 'repair', intensity: 0.6 },
    'partner',
    CONFIG,
    T0 + 3 * HOUR,
  ).desire;
  if (!desire) throw new Error('expected desire');
  return desire;
}

describe('PostgresSocialDesireStore', () => {
  it('persists and reads back a social desire', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    const desire = makeDesire();
    await store.save(desire);
    const loaded = await store.getByContactId('contact-v');
    expect(loaded).not.toBeNull();
    expect(loaded!.warmPressure).toBeCloseTo(desire.warmPressure, 10);
    expect(loaded!.repairPressure).toBeCloseTo(desire.repairPressure, 10);
    expect(loaded!.lastWarmFeltAt).toBe(desire.lastWarmFeltAt);
    expect(loaded!.lastRepairFeltAt).toBe(desire.lastRepairFeltAt);
    expect(loaded!.tierAtLastTick).toBe('partner');
  });

  it('upserts on contact_id: saving twice keeps one row (coalescing)', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    const desire = makeDesire();
    await store.save(desire);
    const strengthened = accumulateSocialDesireSignal(
      desire,
      { contactId: 'contact-v', orientation: 'warm', intensity: 1 },
      'partner',
      CONFIG,
      T0 + 6 * HOUR,
    ).desire!;
    await store.save(strengthened);
    expect(rows.size).toBe(1);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.tickCount).toBe(3);
  });

  it('survives restart: a fresh store hydrates persisted pressure and decay stays deterministic', async () => {
    const rows = new Map<string, FakeRow>();
    const first = newStore(rows);
    const desire = makeDesire();
    await first.save(desire);
    const pressureBefore = decayedSocialDesirePressure(desire, CONFIG, T0 + 30 * HOUR);

    // Simulate a process restart: a brand-new store over the same rows.
    const rebooted = newStore(rows);
    await rebooted.hydrateCache();
    const snapshot = rebooted.snapshotDesires();
    expect(snapshot).toHaveLength(1);
    const hydrated = snapshot[0]!;
    expect(hydrated.contactId).toBe('contact-v');
    const pressureAfter = decayedSocialDesirePressure(hydrated, CONFIG, T0 + 30 * HOUR);
    expect(pressureAfter.total).toBeCloseTo(pressureBefore.total, 10);
    expect(pressureAfter.warm).toBeCloseTo(pressureBefore.warm, 10);
    expect(pressureAfter.repair).toBeCloseTo(pressureBefore.repair, 10);
  });

  it('rejects a persisted row with an invalid tier (fail closed)', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    const desire = makeDesire();
    await store.save(desire);
    rows.get('contact-v')!.tier_at_last_tick = 'stranger';
    const rebooted = newStore(rows);
    await expect(rebooted.hydrateCache()).rejects.toThrow(/invalid tier/);
  });

  it('deletes a persisted desire', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    await store.save(makeDesire());
    expect(await store.delete('contact-v')).toBe(true);
    expect(await store.getByContactId('contact-v')).toBeNull();
  });

  it('rolls back a failed settlement save and applies the stable settlement exactly once on retry', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows, { failSettlementUpdateOnce: true });
    const desire = makeDesire();
    await store.save(desire);
    const input = {
      settlementId: 'outbound-action-1',
      contactId: desire.contactId,
      disposition: 'sent' as const,
      nowMs: T0 + 4 * HOUR,
      lifecycle: CONFIG,
    };

    await expect(store.settle(input)).rejects.toThrow('injected Postgres save failure');
    await expect(store.settle(input)).resolves.toBe('released');
    const settled = await store.getByContactId(desire.contactId);
    expect(decayedSocialDesirePressure(settled!, CONFIG, input.nowMs).total)
      .toBeCloseTo(decayedSocialDesirePressure(desire, CONFIG, input.nowMs).total * CONFIG.releaseFactor, 10);
    await expect(store.settle(input)).resolves.toBe('already_settled');
    expect(decayedSocialDesirePressure((await store.getByContactId(desire.contactId))!, CONFIG, input.nowMs).total)
      .toBeCloseTo(decayedSocialDesirePressure(desire, CONFIG, input.nowMs).total * CONFIG.releaseFactor, 10);
  });
});
