import { createHash } from 'node:crypto';

import type { CompanionFleetEntry } from '../config/companions-config.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

/**
 * Companion fleet lifecycle contracts (h248l.5). One plan/apply shape shared by
 * the CLI and the Fleet UI: requests carry companions.json entry metadata and
 * credential *references* only, never secret values; plans are digest-bound to
 * the exact topology revision they were computed against.
 */
export const FLEET_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const FLEET_LIFECYCLE_ADD_STAGES = [
  'verify_tenant',
  'verify_secret_refs',
  'verify_owner_roots',
  'verify_workspace',
  'verify_fleet_auth',
  'verify_workload',
  'readmit_icp',
  'publish_membership',
] as const;
export const FLEET_LIFECYCLE_REMOVE_STAGES = [
  'fence_icp',
  'verify_fleet_auth_retired',
  'drain_workload',
  'withdraw_membership',
] as const;

export type FleetLifecycleStageId =
  | typeof FLEET_LIFECYCLE_ADD_STAGES[number]
  | typeof FLEET_LIFECYCLE_REMOVE_STAGES[number];

export type FleetLifecycleRequest =
  | Readonly<{
    operation: 'add';
    companion: CompanionFleetEntry;
    /** Required exactly when the companion is ICP lifecycle-fenced (a re-add). */
    readmit?: Readonly<{ confirmCompanionId: string }>;
  }>
  | Readonly<{
    operation: 'remove';
    companionId: string;
    confirmCompanionId: string;
  }>;

/** What removal deliberately leaves in place; purge is a separate workflow. */
interface FleetLifecycleRetention {
  readonly postgresSchema: string;
  readonly companionDataDir: string;
  readonly personalWorkspace: true;
  readonly backups: true;
}

export interface FleetLifecyclePlan {
  readonly schemaVersion: typeof FLEET_LIFECYCLE_SCHEMA_VERSION;
  readonly planId: string;
  readonly createdAt: string;
  readonly operation: 'add' | 'remove';
  readonly companionId: string;
  readonly baseRevision: string;
  readonly targetRevision: string;
  readonly stages: readonly FleetLifecycleStageId[];
  readonly request: FleetLifecycleRequest;
  readonly retention?: FleetLifecycleRetention;
  readonly digest: string;
}

export type FleetLifecycleStageOutcome =
  | 'verified'
  | 'applied'
  | 'already_satisfied'
  | 'fleet_auth_disabled'
  | 'restart_required'
  | 'helm_upgrade_required';

export interface FleetLifecycleReceipt {
  readonly planId: string;
  readonly stageId: FleetLifecycleStageId;
  readonly outcome: FleetLifecycleStageOutcome;
  readonly at: string;
}

export const FLEET_LIFECYCLE_ERROR_CODES = [
  'invalid_request',
  'companion_exists',
  'companion_absent',
  'confirmation_mismatch',
  'primary_removal_unsupported',
  'readmission_requires_reapproval',
  'plan_not_found',
  'plan_integrity_failed',
  'approval_mismatch',
  'stale_topology',
  'resume_required',
  'tenant_unverified',
  'secret_ref_missing',
  'owner_roots_missing',
  'workspace_invalid',
  'fleet_auth_not_admitted',
  'fleet_auth_not_retired',
  'workload_prerequisite_missing',
  'workload_still_running',
  'icp_fence_failed',
  'topology_conflict',
  'stage_error',
] as const;
export type FleetLifecycleErrorCode = typeof FLEET_LIFECYCLE_ERROR_CODES[number];

export class FleetLifecycleError extends Error {
  constructor(
    readonly code: FleetLifecycleErrorCode,
    message: string,
    readonly stageId?: FleetLifecycleStageId,
  ) {
    super(message);
    this.name = 'FleetLifecycleError';
  }
}

export interface FleetLifecycleFailure {
  readonly planId: string;
  readonly stageId: FleetLifecycleStageId;
  readonly code: FleetLifecycleErrorCode;
  readonly at: string;
}

type FleetLifecycleProgressStatus =
  | 'planned'
  | 'in_progress'
  | 'failed'
  | 'applied';

/** Content-free progress view shared by the CLI and the Fleet UI. */
export interface FleetLifecycleProgress {
  readonly plan: FleetLifecyclePlan;
  readonly status: FleetLifecycleProgressStatus;
  readonly receipts: readonly FleetLifecycleReceipt[];
  readonly failure?: FleetLifecycleFailure;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestFleetLifecyclePlan(plan: Omit<FleetLifecyclePlan, 'digest'>): string {
  return sha256Hex(`fleet-lifecycle-plan:v1\0${canonicalJson(plan)}`);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

/**
 * Structural request parse. Entry *semantics* (schema/role names, credential
 * reference shape, path overlap) are validated by the canonical companions.json
 * validator when the planner composes the next topology.
 */
export function parseFleetLifecycleRequest(value: unknown): FleetLifecycleRequest {
  if (!isRecord(value)) throw new FleetLifecycleError('invalid_request', 'Lifecycle request must be an object');
  if (value.operation === 'add') {
    if (!exactKeys(value, ['operation', 'companion'], ['readmit']) || !isRecord(value.companion)) {
      throw new FleetLifecycleError('invalid_request', 'Add request must carry exactly one companion entry');
    }
    let readmit: { confirmCompanionId: string } | undefined;
    if (value.readmit !== undefined) {
      if (!isRecord(value.readmit)
        || !exactKeys(value.readmit, ['confirmCompanionId'])
        || !isRfc4122Uuid(value.readmit.confirmCompanionId)) {
        throw new FleetLifecycleError('invalid_request', 'Add readmit must echo one companion UUID');
      }
      readmit = { confirmCompanionId: value.readmit.confirmCompanionId };
    }
    if (!isRfc4122Uuid(value.companion.companionId)) {
      throw new FleetLifecycleError('invalid_request', 'Add companionId must be a lowercase UUID');
    }
    return Object.freeze({
      operation: 'add',
      companion: structuredClone(value.companion) as unknown as CompanionFleetEntry,
      ...(readmit ? { readmit: Object.freeze(readmit) } : {}),
    });
  }
  if (value.operation === 'remove') {
    if (!exactKeys(value, ['operation', 'companionId', 'confirmCompanionId'])
      || !isRfc4122Uuid(value.companionId)
      || !isRfc4122Uuid(value.confirmCompanionId)) {
      throw new FleetLifecycleError('invalid_request', 'Remove request must name and echo one companion UUID');
    }
    return Object.freeze({
      operation: 'remove',
      companionId: value.companionId,
      confirmCompanionId: value.confirmCompanionId,
    });
  }
  throw new FleetLifecycleError('invalid_request', 'Lifecycle operation must be add or remove');
}
