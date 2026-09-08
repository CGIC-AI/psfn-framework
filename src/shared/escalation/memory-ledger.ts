// ── In-memory human escalation ledger (bead psfn-framework-bznbn) ──
//
// A complete, non-durable implementation of {@link HumanEscalationLedgerPort}.
// It exists so the control plane's semantics — reopen, replay, cooldown,
// conflicting resolution — can be proved without a database, and so the same
// conformance expectations can be run against this and the Postgres store.
//
// It is deliberately NOT a runtime fallback. Composition wires the Postgres
// ledger and fails startup when it is unavailable: an escalation plane that
// forgets across a restart would page an operator again for every open
// condition, which is the exact failure the durable ledger exists to prevent.

import { randomUUID } from 'node:crypto';
import {
  HUMAN_ESCALATION_SCHEMA_VERSION,
  type HumanEscalationAttempt,
  type HumanEscalationAttemptClaim,
  type HumanEscalationDeliveryOutcome,
  type HumanEscalationFacts,
  type HumanEscalationLedgerPort,
  type HumanEscalationListQuery,
  type HumanEscalationRecord,
  type HumanEscalationResolution,
  type HumanEscalationState,
} from './contracts.js';

function dedupeIdentity(kind: string, dedupeKey: string): string {
  return `${kind}\0${dedupeKey}`;
}

function clone(record: HumanEscalationRecord): HumanEscalationRecord {
  return {
    ...record,
    owner: { ...record.owner },
    labels: [...record.labels],
    evidence: { ...record.evidence },
    resolution: record.resolution ? { ...record.resolution } : null,
  };
}

export function createInMemoryHumanEscalationLedger(): HumanEscalationLedgerPort {
  const byIdentity = new Map<string, HumanEscalationRecord>();
  const byId = new Map<string, HumanEscalationRecord>();
  const attempts = new Map<string, HumanEscalationAttempt>();

  return {
    async openOrReopen(facts: HumanEscalationFacts): Promise<HumanEscalationRecord> {
      const identity = dedupeIdentity(facts.kind, facts.dedupeKey);
      const existing = byIdentity.get(identity);
      if (existing) {
        // The runtime restating a condition outranks a human having closed it.
        existing.state = 'open';
        existing.resolution = null;
        existing.severity = facts.severity;
        existing.labels = [...facts.labels];
        existing.evidence = { ...facts.evidence };
        existing.detailPath = facts.detailPath;
        existing.sourceRef = facts.sourceRef;
        existing.lastRaisedAtMs = Math.max(existing.lastRaisedAtMs, facts.raisedAtMs);
        existing.raiseCount += 1;
        return clone(existing);
      }
      const record: HumanEscalationRecord = {
        schemaVersion: HUMAN_ESCALATION_SCHEMA_VERSION,
        escalationId: randomUUID(),
        kind: facts.kind,
        severity: facts.severity,
        owner: { ...facts.owner },
        dedupeKey: facts.dedupeKey,
        sourceRef: facts.sourceRef,
        labels: [...facts.labels],
        evidence: { ...facts.evidence },
        detailPath: facts.detailPath,
        state: 'open',
        resolution: null,
        raisedAtMs: facts.raisedAtMs,
        lastRaisedAtMs: facts.raisedAtMs,
        lastNotifiedAtMs: null,
        raiseCount: 1,
      };
      byIdentity.set(identity, record);
      byId.set(record.escalationId, record);
      return clone(record);
    },

    async findByCondition(kind, dedupeKey): Promise<HumanEscalationRecord | null> {
      const record = byIdentity.get(dedupeIdentity(kind, dedupeKey));
      return record ? clone(record) : null;
    },

    async findAttempt(idempotencyKey: string): Promise<HumanEscalationAttempt | null> {
      const attempt = attempts.get(idempotencyKey);
      return attempt ? { ...attempt } : null;
    },

    /**
     * The map is the primary key. A single-threaded claim looks trivial, but it
     * is the same contract the Postgres ledger takes with `ON CONFLICT DO
     * NOTHING`: whoever gets here first owns the dispatch, and everyone else is
     * handed the owner's row rather than a second notice.
     */
    async claimAttempt(attempt: HumanEscalationAttempt): Promise<HumanEscalationAttemptClaim> {
      const existing = attempts.get(attempt.idempotencyKey);
      if (existing) return { claimed: false, existing: { ...existing } };
      attempts.set(attempt.idempotencyKey, { ...attempt });
      return { claimed: true };
    },

    async settleAttempt(
      idempotencyKey: string,
      outcome: HumanEscalationDeliveryOutcome,
    ): Promise<void> {
      const attempt = attempts.get(idempotencyKey);
      if (!attempt) {
        throw new Error(`Human escalation attempt ${idempotencyKey} is not in the ledger`);
      }
      attempts.set(idempotencyKey, { ...attempt, outcome });
    },

    async markNotified(escalationId: string, notifiedAtMs: number): Promise<void> {
      const record = byId.get(escalationId);
      if (!record) {
        throw new Error(`Human escalation ${escalationId} is not in the ledger`);
      }
      record.lastNotifiedAtMs = record.lastNotifiedAtMs === null
        ? notifiedAtMs
        : Math.max(record.lastNotifiedAtMs, notifiedAtMs);
    },

    async list(query: HumanEscalationListQuery): Promise<HumanEscalationRecord[]> {
      const states: readonly HumanEscalationState[] | undefined = query.states;
      return [...byId.values()]
        .filter(record => states === undefined || states.includes(record.state))
        .sort((left, right) => (
          right.lastRaisedAtMs - left.lastRaisedAtMs
          || right.escalationId.localeCompare(left.escalationId)
        ))
        .slice(0, query.limit)
        .map(clone);
    },

    async countByState(): Promise<Readonly<Record<HumanEscalationState, number>>> {
      const counts: Record<HumanEscalationState, number> = {
        open: 0,
        acknowledged: 0,
        resolved: 0,
        dismissed: 0,
      };
      for (const record of byId.values()) counts[record.state] += 1;
      return counts;
    },

    async getById(escalationId: string): Promise<HumanEscalationRecord | null> {
      const record = byId.get(escalationId);
      return record ? clone(record) : null;
    },

    async applyResolution(input: {
      escalationId: string;
      expectedState: HumanEscalationState;
      resolution: HumanEscalationResolution;
    }): Promise<HumanEscalationRecord | null> {
      const record = byId.get(input.escalationId);
      if (!record || record.state !== input.expectedState) return null;
      record.state = input.resolution.state;
      record.resolution = { ...input.resolution };
      return clone(record);
    },
  };
}
