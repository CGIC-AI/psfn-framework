// ── Social desire store port (epic oth4, bead oth4.1) ──
//
// Persistence contract for per-contact durable social desires. Mirrors the
// weighted-thought store-port pattern: a backend interface (Awaitable) plus a
// Promise-normalized port wrapper and a synchronous cache snapshot for the
// read-hot deterministic paths. Pressure survives restart because the backend
// hydrates its cache from durable storage on connect (the PostgresStore
// hydration lesson, 9vi.13); decay is applied at read time so no decay writer
// is needed across restarts.
//
// Coalescing is structural here: the store is keyed by contactId, so at most
// one durable desire can ever exist per contact.

import type { RelationshipType } from '../contacts/types.js';
import {
  accumulateSocialDesireSignal,
  applySocialDesireDampening,
  releaseSocialDesirePressure,
  type SocialDesire,
  type SocialDesireAccumulationOutcome,
  type SocialDesireFeltSignal,
  type SocialDesireLifecycleConfig,
} from './social-desire.js';

type Awaitable<T> = T | Promise<T>;

export interface SocialDesireStorePortBackend {
  save(desire: SocialDesire): Awaitable<SocialDesire>;
  getByContactId(contactId: string): Awaitable<SocialDesire | null>;
  list(): Awaitable<SocialDesire[]>;
  delete(contactId: string): Awaitable<boolean>;
  settle(input: SocialDesireSettlementInput): Awaitable<SocialDesireSettlementOutcome>;
  /** Synchronous cache snapshot for deterministic zero-I/O evaluation paths. */
  snapshotDesires(): SocialDesire[];
}

export interface SocialDesireStorePort {
  save(desire: SocialDesire): Promise<SocialDesire>;
  getByContactId(contactId: string): Promise<SocialDesire | null>;
  list(): Promise<SocialDesire[]>;
  delete(contactId: string): Promise<boolean>;
  settle(input: SocialDesireSettlementInput): Promise<SocialDesireSettlementOutcome>;
  snapshotDesires(): SocialDesire[];
}

export interface SocialDesireSettlementInput {
  /** Stable durable action/dedupe identity; the exactly-once marker key. */
  settlementId: string;
  contactId: string;
  disposition: 'sent' | 'terminal_block';
  nowMs: number;
  lifecycle: SocialDesireLifecycleConfig;
}

export type SocialDesireSettlementOutcome =
  | 'released'
  | 'dampened'
  | 'already_settled'
  | 'missing';

export function createSocialDesireStorePort(
  backend: SocialDesireStorePortBackend,
): SocialDesireStorePort {
  return {
    save: async (desire) => await backend.save(desire),
    getByContactId: async (contactId) => await backend.getByContactId(contactId),
    list: async () => await backend.list(),
    delete: async (contactId) => await backend.delete(contactId),
    settle: async (input) => await backend.settle(input),
    snapshotDesires: () => backend.snapshotDesires(),
  };
}

/**
 * Current relationship-tier lookup for the accumulation gate. Resolved LIVE at
 * every signal (and again at eligibility time by consumers) so companion-driven
 * tier promotions/demotions immediately change accumulation eligibility.
 */
export interface SocialDesireRelationshipTierSource {
  resolveRelationshipTier(contactId: string): Promise<RelationshipType | null>;
}

/**
 * Tier source over the existing contact store. An unknown contact resolves to
 * null — the accumulation gate treats that exactly like a stranger (fail
 * closed: no relationship basis, no desire).
 */
export function createContactSocialDesireTierSource(
  contacts: {
    getById(id: string): Awaitable<{ relationshipType: RelationshipType } | undefined>;
  },
): SocialDesireRelationshipTierSource {
  return {
    resolveRelationshipTier: async (contactId) => {
      const contact = await contacts.getById(contactId);
      return contact?.relationshipType ?? null;
    },
  };
}

export interface RecordSocialDesireFeltSignalResult {
  desire: SocialDesire | null;
  outcome: SocialDesireAccumulationOutcome;
  /** Tier the gate saw when the signal arrived (null = unknown contact). */
  relationshipType: RelationshipType | null;
}

/**
 * Apply one felt-state signal to the contact's single durable desire and
 * persist the result. This is the ONLY write entry for accumulation: input is a
 * felt signal from the emotion/appraisal path, the current relationship tier is
 * resolved live, and the deterministic math in social-desire.ts decides what
 * (if anything) changes. No LLM, no outbound, no timers.
 */
export async function recordSocialDesireFeltSignal(
  store: Pick<SocialDesireStorePort, 'getByContactId' | 'save'>,
  tierSource: SocialDesireRelationshipTierSource,
  config: SocialDesireLifecycleConfig,
  signal: SocialDesireFeltSignal,
  nowMs: number,
): Promise<RecordSocialDesireFeltSignalResult> {
  const relationshipType = await tierSource.resolveRelationshipTier(signal.contactId);
  const existing = await store.getByContactId(signal.contactId);
  const result = accumulateSocialDesireSignal(existing, signal, relationshipType, config, nowMs);
  if (result.desire && result.desire !== existing) {
    const persisted = await store.save(result.desire);
    return { desire: persisted, outcome: result.outcome, relationshipType };
  }
  return { desire: result.desire, outcome: result.outcome, relationshipType };
}

/**
 * In-memory backend for tests and non-Postgres composition paths. Not a runtime
 * store for production (which is Postgres-only); persistence lives in the
 * adapter (src/core/intention/postgres-adapters/social-desire-adapter.ts).
 */
export function createInMemorySocialDesireBackend(
  initial: readonly SocialDesire[] = [],
): SocialDesireStorePortBackend {
  const desires = new Map<string, SocialDesire>();
  const settlements = new Map<string, Pick<SocialDesireSettlementInput, 'contactId' | 'disposition'>>();
  for (const desire of initial) {
    desires.set(desire.contactId, { ...desire });
  }
  return {
    save: (desire) => {
      const stored = { ...desire, reinforcedConcernIds: [...desire.reinforcedConcernIds] };
      desires.set(stored.contactId, stored);
      return { ...stored };
    },
    getByContactId: (contactId) => {
      const found = desires.get(contactId);
      return found ? { ...found } : null;
    },
    list: () => [...desires.values()].map((desire) => ({ ...desire })),
    delete: (contactId) => desires.delete(contactId),
    settle: (input) => {
      const settlementId = input.settlementId.trim();
      const contactId = input.contactId.trim();
      if (!settlementId || !contactId) {
        throw new Error('Social desire settlement requires stable identities');
      }
      const previous = settlements.get(settlementId);
      if (previous) {
        if (previous.contactId !== contactId || previous.disposition !== input.disposition) {
          throw new Error(`Social desire settlement "${settlementId}" was replayed with conflicting provenance`);
        }
        return 'already_settled';
      }
      const desire = desires.get(contactId);
      if (!desire) return 'missing';
      const settled = input.disposition === 'sent'
        ? releaseSocialDesirePressure(desire, input.lifecycle, input.nowMs)
        : applySocialDesireDampening(desire, input.lifecycle, input.nowMs);
      desires.set(contactId, { ...settled, reinforcedConcernIds: [...settled.reinforcedConcernIds] });
      settlements.set(settlementId, { contactId, disposition: input.disposition });
      return input.disposition === 'sent' ? 'released' : 'dampened';
    },
    snapshotDesires: () => [...desires.values()].map((desire) => ({ ...desire })),
  };
}
