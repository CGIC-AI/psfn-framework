// ── Garden human escalation attention surface (bead psfn-framework-bznbn) ──
//
// One place a person can see everything this runtime is waiting on a human for,
// and say what they did about it. It fabricates nothing: every row here was
// written by the control plane when a domain actually raised an escalation, and
// resolving one writes back to that same durable ledger — so the incident id an
// operator read in a notification, the escalation on this surface, and the
// resolution recorded against it are all the same record.
//
// It is deliberately NOT a generic approval button. The surface carries the
// escalation's `detailPath`, and specialised workflows are answered where they
// live: acknowledging an escalation raised for a quarantined artifact does not
// admit the artifact, and cannot, because this service holds no domain
// authority at all — only the ledger.
//
// Scope, stated rather than implied (bead psfn-framework-e5r0s). This service
// runs in the agent process and reads that process's tenant-pinned ledger. In a
// single-companion deployment the gateway resolves to the same table, so that
// one read already IS the unified view. In fleet mode it is not, and the
// gateway's own escalations — the ones raised for faults no companion can see —
// were unanswerable here. So in fleet mode a SECOND ledger is opened over the
// shared schema the gateway raises its system-owned escalations into, and this
// surface both lists and RESOLVES across the two.
//
// Resolving across two ledgers is the part worth stating. An escalation id is
// unique, so `resolve` looks in this companion's ledger first and then the
// fleet's, and answers 404 when neither holds a row this companion may see. The
// tenancy fence is unchanged and applies to both: a companion-owned row from
// another tenant is 404, not 403, because "exists, but not yours" is an
// enumeration oracle.

import {
  resolveHealthEventOwner,
  type HealthEventOwner,
} from '../../../shared/contracts/health-event.js';
import { sameHealthEventOwner } from '../../../shared/observability/health-detectors/owner.js';
import {
  resolveHumanEscalation,
  type HumanEscalationResolveResult,
} from '../../../shared/escalation/control-plane.js';
import type {
  HumanEscalationActor,
  HumanEscalationLedgerPort,
  HumanEscalationRecord,
  HumanEscalationResolutionReason,
  HumanEscalationResolutionState,
  HumanEscalationState,
} from '../../../shared/escalation/contracts.js';
import type {
  HumanEscalationConfig,
} from '../../../system/config/scheduler-config/human-escalation.js';

/** Which ledger this snapshot was read from, and under whose tenancy. */
interface HumanEscalationScope {
  /** The tenancy whose escalations this surface may show, beside system-owned ones. */
  owner: HealthEventOwner;
  /** The process whose durable ledger was read. */
  process: 'agent';
  /**
   * Every ledger actually read. `companion` is this process's tenant-pinned
   * ledger; `fleet_system` is the shared-schema ledger the gateway raises its
   * system-owned escalations into, present only when a fleet deployment wired
   * it.
   */
  ledgers: readonly HumanEscalationLedgerScope[];
  /** Rows the surface may return per refresh, from the owner file. */
  listLimit: number;
}

/** One durable ledger this snapshot was assembled from. */
type HumanEscalationLedgerScope = 'companion' | 'fleet_system';

export interface HumanEscalationSnapshot {
  generatedAt: number;
  scope: HumanEscalationScope;
  /**
   * Content-free telemetry: how many escalations sit in each state right now,
   * counted in the ledger rather than inferred from the returned page.
   */
  counts: Readonly<Record<HumanEscalationState, number>>;
  /** Newest activity first; empty when nothing is waiting on a person. */
  escalations: HumanEscalationRecord[];
}

export interface AdminHumanEscalationService {
  getSnapshot(states: readonly HumanEscalationState[] | undefined): Promise<HumanEscalationSnapshot>;
  resolve(input: {
    escalationId: string;
    state: HumanEscalationResolutionState;
    reason: HumanEscalationResolutionReason;
    actor: HumanEscalationActor;
  }): Promise<HumanEscalationResolveResult>;
}

export interface AdminHumanEscalationServiceOptions {
  ledger: HumanEscalationLedgerPort;
  /**
   * The fleet's system-owned ledger, present only in fleet mode (bead
   * psfn-framework-e5r0s). Absent in a single-companion deployment, where
   * `ledger` already resolves to the table the gateway raises into.
   */
  fleetSystemLedger?: HumanEscalationLedgerPort;
  config: () => HumanEscalationConfig;
  /** This runtime's companion identity; absent for a shard with no core tenancy. */
  companionId?: string;
  now?: () => number;
}

function sumStateCounts(
  left: Readonly<Record<HumanEscalationState, number>>,
  right: Readonly<Record<HumanEscalationState, number>>,
): Readonly<Record<HumanEscalationState, number>> {
  return {
    open: left.open + right.open,
    acknowledged: left.acknowledged + right.acknowledged,
    resolved: left.resolved + right.resolved,
    dismissed: left.dismissed + right.dismissed,
  };
}

export class AdminHumanEscalationDataService implements AdminHumanEscalationService {
  private readonly owner: HealthEventOwner;

  constructor(private readonly options: AdminHumanEscalationServiceOptions) {
    this.owner = resolveHealthEventOwner(options.companionId);
  }

  async getSnapshot(
    states: readonly HumanEscalationState[] | undefined,
  ): Promise<HumanEscalationSnapshot> {
    const config = this.options.config();
    const nowMs = (this.options.now ?? (() => Date.now()))();
    const query = {
      ...(states === undefined ? {} : { states }),
      limit: config.listLimit,
    };
    const fleet = this.options.fleetSystemLedger;
    // Each ledger is read at the FULL owner-file page size rather than the two
    // splitting one: a noisy fleet must not be able to push this companion's own
    // escalations off the page an operator is looking at.
    const [rows, counts, fleetRows, fleetCounts] = await Promise.all([
      this.options.ledger.list(query),
      this.options.ledger.countByState(),
      fleet ? fleet.list(query) : Promise.resolve([]),
      fleet ? fleet.countByState() : Promise.resolve(null),
    ]);
    const visible = [...rows, ...fleetRows]
      .filter(row => this.isVisible(row))
      .sort((left, right) => (
        right.lastRaisedAtMs - left.lastRaisedAtMs
        || right.escalationId.localeCompare(left.escalationId)
      ))
      .slice(0, config.listLimit);
    return {
      generatedAt: nowMs,
      scope: {
        owner: this.owner,
        process: 'agent',
        ledgers: fleet ? ['companion', 'fleet_system'] : ['companion'],
        listLimit: config.listLimit,
      },
      // Summed, not taken from one ledger: a count that described half of what
      // the list shows would be worse than no count at all.
      counts: fleetCounts ? sumStateCounts(counts, fleetCounts) : counts,
      escalations: visible,
    };
  }

  /**
   * Resolve, tenancy-fenced. A foreign companion's escalation answers 404
   * rather than 403: a Garden that says "exists, but not yours" is an
   * enumeration oracle for another tenant's incidents.
   */
  async resolve(input: {
    escalationId: string;
    state: HumanEscalationResolutionState;
    reason: HumanEscalationResolutionReason;
    actor: HumanEscalationActor;
  }): Promise<HumanEscalationResolveResult> {
    // This companion's own ledger first, then the fleet's. Ids are unique, so
    // the order is a cost decision rather than a semantic one — and the write
    // goes back to whichever ledger actually holds the row, never to the other.
    const ledgers: readonly HumanEscalationLedgerPort[] = this.options.fleetSystemLedger
      ? [this.options.ledger, this.options.fleetSystemLedger]
      : [this.options.ledger];
    for (const ledger of ledgers) {
      const existing = await ledger.getById(input.escalationId);
      if (!existing) continue;
      if (!this.isVisible(existing)) break;
      return await resolveHumanEscalation(ledger, {
        ...input,
        resolvedAtMs: (this.options.now ?? (() => Date.now()))(),
      });
    }
    return { ok: false, status: 404, error: 'Escalation not found' };
  }

  /**
   * Tenancy fence, mirroring the incident timeline: a companion-owned
   * escalation is visible only to its own companion's Garden; system-owned ones
   * belong to the runtime and are visible to whoever can read this surface. In
   * fleet mode the agent's ledger is already pinned to its tenant schema, so
   * this is a second independent fence rather than the only one.
   */
  private isVisible(record: HumanEscalationRecord): boolean {
    return record.owner.kind === 'system' || sameHealthEventOwner(record.owner, this.owner);
  }
}
