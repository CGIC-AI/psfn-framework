import type { CompanionFleetEntry, CompanionsFleetConfig } from '../config/companions-config.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import {
  FleetLifecycleError,
  type FleetLifecyclePlan,
  type FleetLifecycleProgress,
  type FleetLifecycleStageId,
  type FleetLifecycleStageOutcome,
} from './contracts.js';
import { nextTopologyForPlan } from './plan.js';
import type { FleetLifecyclePlanStore } from './plan-store.js';
import type { FleetLifecyclePorts } from './ports.js';

interface StageContext {
  readonly plan: FleetLifecyclePlan;
  readonly base: { readonly config: CompanionsFleetConfig; readonly revision: string };
  readonly ports: FleetLifecyclePorts;
  readonly nowMs: number;
}

function addedEntry(plan: FleetLifecyclePlan): CompanionFleetEntry {
  if (plan.request.operation !== 'add') throw new Error('Stage requires an add plan');
  return plan.request.companion;
}

async function publishTopology(context: StageContext): Promise<FleetLifecycleStageOutcome> {
  const { plan, ports } = context;
  if (ports.topology.read().revision === plan.targetRevision) return 'already_satisfied';
  const next = nextTopologyForPlan(plan, context.base.config);
  if (ports.topology.revisionOf(next) !== plan.targetRevision) {
    throw new FleetLifecycleError('topology_conflict', 'Recomputed topology no longer matches the approved plan');
  }
  ports.topology.publish(next, plan.baseRevision);
  return 'restart_required';
}

const STAGES: Readonly<Record<FleetLifecycleStageId, (context: StageContext) => Promise<FleetLifecycleStageOutcome>>> = {
  async verify_tenant(context) {
    await context.ports.prerequisites.verifyTenant(addedEntry(context.plan), context.base.config);
    return 'verified';
  },
  async verify_secret_refs(context) {
    await context.ports.prerequisites.verifySecretRefs(addedEntry(context.plan), context.base.config);
    return 'verified';
  },
  async verify_owner_roots(context) {
    await context.ports.prerequisites.verifyOwnerRoots(addedEntry(context.plan));
    return 'verified';
  },
  async verify_workspace(context) {
    await context.ports.prerequisites.verifyWorkspace(
      addedEntry(context.plan),
      nextTopologyForPlan(context.plan, context.base.config),
    );
    return 'verified';
  },
  async verify_fleet_auth(context) {
    const fleetAuth = context.ports.fleetAuth;
    if (fleetAuth.disabled) return 'fleet_auth_disabled';
    const state = await fleetAuth.readCompanion(context.plan.companionId);
    // A never-registered companion is a fresh add; fleet auth registers it
    // through its own roster ceremonies. A retired one (removed/quarantined)
    // must come back through fleet-auth readd + reapproval first.
    if (state.state === 'absent') return 'verified';
    if (state.lifecycle !== 'active' || state.restoreState !== 'live') {
      throw new FleetLifecycleError(
        'fleet_auth_not_admitted',
        'Fleet-auth companion authority must be active and live (complete readd/reapproval first)',
      );
    }
    return 'verified';
  },
  async verify_workload(context) {
    return await context.ports.workload.verifyPrerequisites(addedEntry(context.plan));
  },
  async readmit_icp(context) {
    const result = await context.ports.icpFence.clear(context.plan.companionId, context.nowMs);
    return result.transitioned ? 'applied' : 'already_satisfied';
  },
  publish_membership: publishTopology,
  async fence_icp(context) {
    const result = await context.ports.icpFence.fence(context.plan.companionId, context.nowMs);
    return result.transitioned ? 'applied' : 'already_satisfied';
  },
  async verify_fleet_auth_retired(context) {
    const fleetAuth = context.ports.fleetAuth;
    if (fleetAuth.disabled) return 'fleet_auth_disabled';
    const state = await fleetAuth.readCompanion(context.plan.companionId);
    if (state.state === 'absent') return 'already_satisfied';
    // Retirement is the human-authorized fleet-auth companion.remove
    // ceremony; the reconciler verifies it and never forges that decision.
    if (state.lifecycle !== 'removed') {
      throw new FleetLifecycleError(
        'fleet_auth_not_retired',
        'Complete the fleet-auth companion removal ceremony before removing the companion',
      );
    }
    return 'verified';
  },
  async drain_workload(context) {
    return await context.ports.workload.drain(context.plan.companionId);
  },
  withdraw_membership: publishTopology,
};

/**
 * Apply one approved plan. Order is the plan's stage order: prerequisites
 * first, roster membership last, so any failure leaves the old topology in
 * place. Re-applying a completed plan is a no-op; a partially applied plan
 * continues only with explicit `resume`; any other topology revision than the
 * plan's base fails closed before a single side effect.
 */
export async function applyFleetLifecyclePlan(input: {
  readonly planId: string;
  readonly approval: Readonly<{ planDigest: string }>;
  readonly resume?: boolean;
  readonly store: FleetLifecyclePlanStore;
  readonly ports: FleetLifecyclePorts;
  readonly now?: () => Date;
}): Promise<FleetLifecycleProgress> {
  const now = input.now ?? (() => new Date());
  const plan = input.store.loadPlan(input.planId);
  if (typeof input.approval.planDigest !== 'string'
    || !timingSafeStringEqual(input.approval.planDigest, plan.digest)) {
    throw new FleetLifecycleError('approval_mismatch', 'Approval does not name this exact plan digest');
  }
  const done = new Set(input.store.receipts(plan).map(receipt => receipt.stageId));
  if (plan.stages.every(stage => done.has(stage))) return input.store.progress(plan.planId);

  const base = input.ports.topology.read();
  if (base.revision !== plan.baseRevision && base.revision !== plan.targetRevision) {
    throw new FleetLifecycleError('stale_topology', 'Topology changed since this plan was computed; plan again');
  }
  if ((done.size > 0 || input.store.failure(plan.planId)) && input.resume !== true) {
    throw new FleetLifecycleError('resume_required', 'Plan was partially applied; resume it explicitly');
  }

  for (const stageId of plan.stages) {
    if (done.has(stageId)) continue;
    const at = now();
    let outcome: FleetLifecycleStageOutcome;
    try {
      outcome = await STAGES[stageId]({ plan, base, ports: input.ports, nowMs: at.getTime() });
    } catch (error) {
      const failure = error instanceof FleetLifecycleError
        ? error
        : new FleetLifecycleError('stage_error', error instanceof Error ? error.message : String(error), stageId);
      input.store.recordFailure({ planId: plan.planId, stageId, code: failure.code, at: at.toISOString() });
      throw new FleetLifecycleError(failure.code, failure.message, stageId);
    }
    input.store.recordReceipt({ planId: plan.planId, stageId, outcome, at: now().toISOString() });
  }
  return input.store.progress(plan.planId);
}
