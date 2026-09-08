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
// Scope, stated rather than implied. The gateway and the agent each raise onto
// their own pool scope: the agent's ledger is pinned to its companion tenant
// schema in fleet mode, the gateway's runs on its own credential's default
// search_path. This service reads the ledger of the process it runs in — the
// agent's — exactly like the incident timeline beside it. Where both processes
// resolve to the same table that is the unified view; where they do not, it is
// this process's ledger, and the snapshot says which.

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
  /** Rows the surface may return per refresh, from the owner file. */
  listLimit: number;
}

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
  config: () => HumanEscalationConfig;
  /** This runtime's companion identity; absent for a shard with no core tenancy. */
  companionId?: string;
  now?: () => number;
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
    const [rows, counts] = await Promise.all([
      this.options.ledger.list({
        ...(states === undefined ? {} : { states }),
        limit: config.listLimit,
      }),
      this.options.ledger.countByState(),
    ]);
    return {
      generatedAt: nowMs,
      scope: { owner: this.owner, process: 'agent', listLimit: config.listLimit },
      counts,
      escalations: rows.filter(row => this.isVisible(row)),
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
    const existing = await this.options.ledger.getById(input.escalationId);
    if (!existing || !this.isVisible(existing)) {
      return { ok: false, status: 404, error: 'Escalation not found' };
    }
    return await resolveHumanEscalation(this.options.ledger, {
      ...input,
      resolvedAtMs: (this.options.now ?? (() => Date.now()))(),
    });
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
