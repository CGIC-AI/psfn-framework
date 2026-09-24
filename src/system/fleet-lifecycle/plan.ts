import { randomUUID } from 'node:crypto';

import {
  validateCompanionsConfig,
  type CompanionsFleetConfig,
} from '../config/companions-config.js';
import {
  FLEET_LIFECYCLE_ADD_STAGES,
  FLEET_LIFECYCLE_REMOVE_STAGES,
  FLEET_LIFECYCLE_SCHEMA_VERSION,
  FleetLifecycleError,
  parseFleetLifecycleRequest,
  type FleetLifecyclePlan,
  type FleetLifecycleStageId,
} from './contracts.js';
import { digestFleetLifecyclePlan } from './digest.js';
import type { FleetTopologyPort, IcpLifecycleFencePort } from './ports.js';

function composeNextTopology(
  current: CompanionsFleetConfig,
  companions: CompanionsFleetConfig['companions'],
): CompanionsFleetConfig {
  try {
    return validateCompanionsConfig(
      { postgres: current.postgres, companions },
      'companions.json (planned)',
    );
  } catch (error) {
    throw new FleetLifecycleError(
      'invalid_request',
      error instanceof Error ? error.message : 'Planned companions.json is invalid',
    );
  }
}

/**
 * Dry-run planner: reads only. Computes the exact next topology through the
 * canonical companions.json validator and binds the plan to the current and
 * target revision digests. Nothing is published or fenced here.
 */
export async function planFleetLifecycle(input: {
  readonly request: unknown;
  readonly topology: Pick<FleetTopologyPort, 'read' | 'revisionOf'>;
  readonly icpFence: Pick<IcpLifecycleFencePort, 'isFenced'>;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}): Promise<FleetLifecyclePlan> {
  const request = parseFleetLifecycleRequest(input.request);
  const { config, revision } = input.topology.read();
  const now = (input.now ?? (() => new Date()))();
  let next: CompanionsFleetConfig;
  let stages: FleetLifecycleStageId[];
  let companionId: string;
  let retention: FleetLifecyclePlan['retention'];

  if (request.operation === 'add') {
    companionId = request.companion.companionId;
    if (config.companions.some(entry => entry.companionId === companionId)) {
      throw new FleetLifecycleError('companion_exists', 'Companion is already a fleet member');
    }
    next = composeNextTopology(config, [...config.companions, request.companion]);
    const fenced = await input.icpFence.isFenced(companionId);
    if (fenced && request.readmit?.confirmCompanionId !== companionId) {
      throw new FleetLifecycleError(
        'readmission_requires_reapproval',
        'Companion was previously removed; re-add requires fleet-auth readd/reapproval and an explicit readmit confirmation',
      );
    }
    if (!fenced && request.readmit !== undefined) {
      throw new FleetLifecycleError('invalid_request', 'Readmit applies only to a previously removed companion');
    }
    stages = FLEET_LIFECYCLE_ADD_STAGES.filter(stage => stage !== 'readmit_icp' || fenced);
  } else {
    companionId = request.companionId;
    if (request.confirmCompanionId !== companionId) {
      throw new FleetLifecycleError('confirmation_mismatch', 'Removal confirmation must echo the exact companion');
    }
    const index = config.companions.findIndex(entry => entry.companionId === companionId);
    if (index < 0) throw new FleetLifecycleError('companion_absent', 'Companion is not a fleet member');
    if (index === 0) {
      throw new FleetLifecycleError(
        'primary_removal_unsupported',
        'The first manifest entry is the primary companion and cannot be removed by this workflow',
      );
    }
    const removed = config.companions[index]!;
    next = composeNextTopology(config, config.companions.filter(entry => entry.companionId !== companionId));
    stages = [...FLEET_LIFECYCLE_REMOVE_STAGES];
    retention = Object.freeze({
      postgresSchema: removed.postgresSchema,
      companionDataDir: removed.companionDataDir,
      personalWorkspace: true,
      backups: true,
    });
  }

  const body: Omit<FleetLifecyclePlan, 'digest'> = {
    schemaVersion: FLEET_LIFECYCLE_SCHEMA_VERSION,
    planId: (input.randomUuid ?? randomUUID)(),
    createdAt: now.toISOString(),
    operation: request.operation,
    companionId,
    baseRevision: revision,
    targetRevision: input.topology.revisionOf(next),
    stages: Object.freeze(stages),
    request,
    ...(retention ? { retention } : {}),
  };
  return Object.freeze({ ...body, digest: digestFleetLifecyclePlan(body) });
}

/** Recompute the next topology for an approved plan from the live base. */
export function nextTopologyForPlan(
  plan: FleetLifecyclePlan,
  current: CompanionsFleetConfig,
): CompanionsFleetConfig {
  if (plan.request.operation === 'add') {
    return composeNextTopology(current, [...current.companions, plan.request.companion]);
  }
  const removedId = plan.request.companionId;
  return composeNextTopology(current, current.companions.filter(entry => entry.companionId !== removedId));
}
