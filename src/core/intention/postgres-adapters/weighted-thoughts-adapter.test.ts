import { describe, expect, it } from 'vitest';
import { PostgresWeightedThoughtStore } from './weighted-thoughts-adapter.js';
import {
  createThoughtWeight,
  decayedWeight,
  type WeightedThoughtLifecycleConfig,
} from '../weighted-thoughts.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-02T12:00:00.000Z');

const CONFIG: WeightedThoughtLifecycleConfig = {
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

interface FakeRow {
  id: string;
  content: string;
  source: string;
  thought_class: string;
  contact_id: string | null;
  base_weight: number;
  context_multipliers: string;
  accumulated_weight: number;
  reinforcement_count: number;
  decay_halflife_ms: number;
  created_at: string;
  last_reinforced_at: string;
  provenance: string;
  nudge_state: string;
  last_nudged_at: string | null;
  decline_count: number;
}

/**
 * Minimal fake Pool that persists weighted_thoughts rows in a shared Map so a
 * fresh store instance can hydrate from the same "durable" storage — modelling
 * the restart path.
 */
class FakeWeightedThoughtPool {
  constructor(private readonly rows: Map<string, FakeRow>) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: FakeRow[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('INSERT INTO weighted_thoughts')) {
      const row: FakeRow = {
        id: values[0] as string,
        content: values[1] as string,
        source: values[2] as string,
        thought_class: values[3] as string,
        contact_id: (values[4] as string | null) ?? null,
        base_weight: values[5] as number,
        context_multipliers: values[6] as string,
        accumulated_weight: values[7] as number,
        reinforcement_count: values[8] as number,
        decay_halflife_ms: values[9] as number,
        created_at: values[10] as string,
        last_reinforced_at: values[11] as string,
        provenance: values[12] as string,
        nudge_state: values[13] as string,
        last_nudged_at: (values[14] as string | null) ?? null,
        decline_count: values[15] as number,
      };
      this.rows.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT') && sql.includes('WHERE id = $1')) {
      const found = this.rows.get(values[0] as string);
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith('DELETE FROM weighted_thoughts')) {
      const id = values[0] as string;
      const existed = this.rows.delete(id);
      return { rows: existed ? [{ id } as unknown as FakeRow] : [] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM weighted_thoughts')) {
      // Covers both hydrateCache (no WHERE) and list().
      return { rows: [...this.rows.values()] };
    }
    throw new Error(`Unhandled SQL in FakeWeightedThoughtPool: ${sql}`);
  }
}

function newStore(rows: Map<string, FakeRow>): PostgresWeightedThoughtStore {
  return new PostgresWeightedThoughtStore(new FakeWeightedThoughtPool(rows) as never);
}

describe('PostgresWeightedThoughtStore', () => {
  it('persists and reads back a weighted thought', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    const thought = createThoughtWeight(
      {
        id: 'wt-1',
        content: 'check in on V',
        source: 'concern',
        thoughtClass: 'time_sensitive',
        contactId: 'contact-v',
        provenance: { concernId: 'concern-1', sourceChannelId: 'chan-1', sourceChannelType: 'discord' },
      },
      CONFIG,
      T0,
    );
    await store.save(thought);
    const loaded = await store.getById('wt-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe('check in on V');
    expect(loaded!.provenance.concernId).toBe('concern-1');
    expect(loaded!.provenance.sourceChannelType).toBe('discord');
    expect(loaded!.contactId).toBe('contact-v');
  });

  it('survives restart: a fresh store hydrates persisted weights', async () => {
    const rows = new Map<string, FakeRow>();
    const first = newStore(rows);
    const thought = createThoughtWeight(
      { id: 'wt-2', content: 'thank him', source: 'appraisal', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    await first.save(thought);

    // Simulate a process restart: a brand-new store over the same rows.
    const rebooted = newStore(rows);
    await rebooted.hydrateCache();
    const snapshot = rebooted.snapshotActiveThoughts();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.id).toBe('wt-2');
    // Decay is deterministic from the persisted lastReinforcedAt.
    expect(decayedWeight(snapshot[0]!, T0 + 24 * HOUR)).toBeCloseTo(thought.accumulatedWeight / 2, 6);
  });

  it('excludes accepted thoughts from the active snapshot', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    const pending = createThoughtWeight(
      { id: 'wt-pending', content: 'a', source: 's', thoughtClass: 'standard' },
      CONFIG,
      T0,
    );
    const accepted = {
      ...createThoughtWeight({ id: 'wt-accepted', content: 'b', source: 's', thoughtClass: 'standard' }, CONFIG, T0),
      nudgeState: 'accepted' as const,
    };
    await store.save(pending);
    await store.save(accepted);
    await store.hydrateCache();
    expect(store.snapshotActiveThoughts().map((t) => t.id)).toEqual(['wt-pending']);
  });

  it('deletes a persisted thought', async () => {
    const rows = new Map<string, FakeRow>();
    const store = newStore(rows);
    await store.save(createThoughtWeight({ id: 'wt-3', content: 'x', source: 's', thoughtClass: 'trivial' }, CONFIG, T0));
    expect(await store.delete('wt-3')).toBe(true);
    expect(await store.getById('wt-3')).toBeNull();
  });
});
