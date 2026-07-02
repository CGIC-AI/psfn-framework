// ── Weighted-thought store port (Charter 6.24) ──
//
// Persistence contract for weighted thoughts. Mirrors the concern/pending-
// follow-up store-port pattern: a backend interface (Awaitable) plus a Promise-
// normalized port wrapper and a synchronous cache snapshot for the read-hot
// trigger path. Weights survive restart because the backend hydrates its cache
// from durable storage on connect (the PostgresStore hydration lesson, 9vi.13).

import {
  createThoughtWeight,
  reinforceThoughtWeight,
  topWeightedThoughts,
  type CreateThoughtWeightInput,
  type ThoughtReinforcementSignal,
  type ThoughtWeight,
  type WeightedThoughtLifecycleConfig,
  type WeightedThoughtView,
} from './weighted-thoughts.js';

type Awaitable<T> = T | Promise<T>;

export interface WeightedThoughtListOptions {
  contactId?: string;
  /** When set, only thoughts still eligible for a nudge (not accepted). */
  activeOnly?: boolean;
  limit?: number;
}

export interface WeightedThoughtStorePortBackend {
  save(thought: ThoughtWeight): Awaitable<ThoughtWeight>;
  getById(id: string): Awaitable<ThoughtWeight | null>;
  list(options?: WeightedThoughtListOptions): Awaitable<ThoughtWeight[]>;
  delete(id: string): Awaitable<boolean>;
  /** Synchronous cache snapshot for the deterministic trigger gate. */
  snapshotActiveThoughts(contactId?: string): ThoughtWeight[];
}

export interface WeightedThoughtStorePort {
  save(thought: ThoughtWeight): Promise<ThoughtWeight>;
  getById(id: string): Promise<ThoughtWeight | null>;
  list(options?: WeightedThoughtListOptions): Promise<ThoughtWeight[]>;
  delete(id: string): Promise<boolean>;
  snapshotActiveThoughts(contactId?: string): ThoughtWeight[];
}

export function createWeightedThoughtStorePort(
  backend: WeightedThoughtStorePortBackend,
): WeightedThoughtStorePort {
  return {
    save: async (thought) => await backend.save(thought),
    getById: async (id) => await backend.getById(id),
    list: async (options) => await backend.list(options),
    delete: async (id) => await backend.delete(id),
    snapshotActiveThoughts: (contactId) => backend.snapshotActiveThoughts(contactId),
  };
}

/**
 * Create-or-reinforce a weighted thought keyed by `input.id`. Existing thoughts
 * are reinforced (recency decay + fresh increment) rather than duplicated;
 * absent ones are created. Deterministic — the math lives in weighted-thoughts.
 */
export async function recordWeightedThought(
  store: Pick<WeightedThoughtStorePort, 'getById' | 'save'>,
  config: WeightedThoughtLifecycleConfig,
  input: CreateThoughtWeightInput,
  nowMs: number,
): Promise<ThoughtWeight> {
  const existing = await store.getById(input.id);
  if (existing) {
    const signal: ThoughtReinforcementSignal = {
      ...(input.emotionalIntensity !== undefined ? { emotionalIntensity: input.emotionalIntensity } : {}),
      ...(input.relationshipMultiplier !== undefined ? { relationshipMultiplier: input.relationshipMultiplier } : {}),
    };
    return await store.save(reinforceThoughtWeight(existing, signal, config, nowMs));
  }
  return await store.save(createThoughtWeight(input, config, nowMs));
}

/** Top-N currently-relevant thoughts from the cache snapshot (no I/O). */
export function topWeightedThoughtsFromStore(
  store: Pick<WeightedThoughtStorePort, 'snapshotActiveThoughts'>,
  config: WeightedThoughtLifecycleConfig,
  nowMs: number,
  limit: number,
  contactId?: string,
): WeightedThoughtView[] {
  return topWeightedThoughts(
    store.snapshotActiveThoughts(contactId),
    nowMs,
    limit,
    config.relevanceFloor,
  );
}

/**
 * In-memory backend for tests and the non-Postgres path. Not a runtime store
 * for production (which is Postgres-only); persistence lives in the adapter.
 */
export function createInMemoryWeightedThoughtBackend(
  initial: readonly ThoughtWeight[] = [],
): WeightedThoughtStorePortBackend {
  const thoughts = new Map<string, ThoughtWeight>();
  for (const thought of initial) {
    thoughts.set(thought.id, { ...thought });
  }
  const matchesContact = (thought: ThoughtWeight, contactId?: string): boolean => (
    !contactId || !thought.contactId || thought.contactId === contactId
  );
  return {
    save: (thought) => {
      const stored = { ...thought };
      thoughts.set(stored.id, stored);
      return { ...stored };
    },
    getById: (id) => {
      const found = thoughts.get(id);
      return found ? { ...found } : null;
    },
    list: (options) => {
      const activeOnly = options?.activeOnly === true;
      const limit = options?.limit;
      const rows = [...thoughts.values()]
        .filter((thought) => matchesContact(thought, options?.contactId))
        .filter((thought) => (activeOnly ? thought.nudgeState !== 'accepted' : true))
        .map((thought) => ({ ...thought }));
      return typeof limit === 'number' && limit > 0 ? rows.slice(0, Math.floor(limit)) : rows;
    },
    delete: (id) => thoughts.delete(id),
    snapshotActiveThoughts: (contactId) => (
      [...thoughts.values()]
        .filter((thought) => thought.nudgeState !== 'accepted')
        .filter((thought) => matchesContact(thought, contactId))
        .map((thought) => ({ ...thought }))
    ),
  };
}
