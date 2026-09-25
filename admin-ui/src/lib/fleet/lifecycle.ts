import { hasExactKeys, isRecord, isRfc4122Uuid } from '../../../../src/shared/utils/types.js';
import {
  FLEET_LIFECYCLE_ADD_STAGES,
  FLEET_LIFECYCLE_ERROR_CODES,
  FLEET_LIFECYCLE_REMOVE_STAGES,
  parseFleetLifecycleRequest,
  type FleetLifecycleErrorCode,
  type FleetLifecyclePlan,
  type FleetLifecycleProgress,
  type FleetLifecycleReceipt,
  type FleetLifecycleStageId,
} from '../../../../src/system/fleet-lifecycle/contracts.js';

/**
 * Fleet lifecycle client (h248l.6). The UI is a projection and command client
 * of the gateway's shared reconciler: it parses the exact plan/progress
 * contracts the CLI prints, carries only credential references, and never
 * persists plans or requests in browser storage.
 */
const LIFECYCLE_PATH = '/v1/fleet/lifecycle/plans';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STAGES: readonly string[] = [...FLEET_LIFECYCLE_ADD_STAGES, ...FLEET_LIFECYCLE_REMOVE_STAGES];
const OUTCOMES = [
  'verified', 'applied', 'already_satisfied', 'fleet_auth_disabled', 'restart_required', 'helm_upgrade_required',
];
const MAX_LISTED_PLANS = 50;

type FleetLifecycleApplyMode = 'local' | 'cli_only';

export interface FleetLifecycleListing {
  applyMode: FleetLifecycleApplyMode;
  plans: FleetLifecycleProgress[];
}

export class FleetLifecycleRequestError extends Error {
  constructor(readonly code: FleetLifecycleErrorCode | 'fleet_lifecycle_unavailable', readonly stageId?: string) {
    super(code);
    this.name = 'FleetLifecycleRequestError';
  }
}

function fail(message: string): never {
  throw new Error(`Cluster lifecycle returned ${message}`);
}

function stageId(value: unknown): FleetLifecycleStageId {
  if (typeof value !== 'string' || !STAGES.includes(value)) fail('an unknown stage');
  return value as FleetLifecycleStageId;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('an invalid timestamp');
  return value;
}

function parseFleetLifecyclePlan(value: unknown): FleetLifecyclePlan {
  const keys = ['schemaVersion', 'planId', 'createdAt', 'operation', 'companionId', 'baseRevision',
    'targetRevision', 'stages', 'request', 'digest'];
  if (!isRecord(value)
    || !hasExactKeys(value, value.retention === undefined ? keys : [...keys, 'retention'])
    || value.schemaVersion !== 1
    || !isRfc4122Uuid(value.planId)
    || (value.operation !== 'add' && value.operation !== 'remove')
    || !isRfc4122Uuid(value.companionId)
    || typeof value.baseRevision !== 'string' || !DIGEST_PATTERN.test(value.baseRevision)
    || typeof value.targetRevision !== 'string' || !DIGEST_PATTERN.test(value.targetRevision)
    || typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)
    || !Array.isArray(value.stages)) {
    fail('an invalid plan');
  }
  const request = parseFleetLifecycleRequest(value.request);
  if (request.operation !== value.operation) fail('a plan whose request does not match its operation');
  let retention: FleetLifecyclePlan['retention'];
  if (value.retention !== undefined) {
    const raw = value.retention;
    if (!isRecord(raw)
      || !hasExactKeys(raw, ['postgresSchema', 'companionDataDir', 'personalWorkspace', 'backups'])
      || typeof raw.postgresSchema !== 'string' || typeof raw.companionDataDir !== 'string'
      || raw.personalWorkspace !== true || raw.backups !== true) {
      fail('an invalid retention statement');
    }
    retention = {
      postgresSchema: raw.postgresSchema,
      companionDataDir: raw.companionDataDir,
      personalWorkspace: true,
      backups: true,
    };
  }
  return {
    schemaVersion: 1,
    planId: value.planId,
    createdAt: timestamp(value.createdAt),
    operation: value.operation,
    companionId: value.companionId,
    baseRevision: value.baseRevision,
    targetRevision: value.targetRevision,
    stages: value.stages.map(stageId),
    request,
    ...(retention ? { retention } : {}),
    digest: value.digest,
  };
}

function parseReceipt(value: unknown, planId: string): FleetLifecycleReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ['planId', 'stageId', 'outcome', 'at'])
    || value.planId !== planId || !OUTCOMES.includes(String(value.outcome))) {
    fail('an invalid receipt');
  }
  return {
    planId,
    stageId: stageId(value.stageId),
    outcome: value.outcome as FleetLifecycleReceipt['outcome'],
    at: timestamp(value.at),
  };
}

export function parseFleetLifecycleProgress(value: unknown): FleetLifecycleProgress {
  if (!isRecord(value)
    || !hasExactKeys(value, value.failure === undefined
      ? ['plan', 'status', 'receipts']
      : ['plan', 'status', 'receipts', 'failure'])
    || !['planned', 'in_progress', 'failed', 'applied'].includes(String(value.status))
    || !Array.isArray(value.receipts)) {
    fail('invalid progress');
  }
  const plan = parseFleetLifecyclePlan(value.plan);
  let failure: FleetLifecycleProgress['failure'];
  if (value.failure !== undefined) {
    const raw = value.failure;
    if (!isRecord(raw) || !hasExactKeys(raw, ['planId', 'stageId', 'code', 'at']) || raw.planId !== plan.planId
      || !(FLEET_LIFECYCLE_ERROR_CODES as readonly string[]).includes(String(raw.code))) {
      fail('an invalid failure');
    }
    failure = {
      planId: plan.planId,
      stageId: stageId(raw.stageId),
      code: raw.code as FleetLifecycleErrorCode,
      at: timestamp(raw.at),
    };
  }
  return {
    plan,
    status: value.status as FleetLifecycleProgress['status'],
    receipts: value.receipts.map(receipt => parseReceipt(receipt, plan.planId)),
    ...(failure ? { failure } : {}),
  };
}

export function parseFleetLifecycleListing(value: unknown): FleetLifecycleListing {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'applyMode', 'plans'])
    || value.schemaVersion !== 1
    || (value.applyMode !== 'local' && value.applyMode !== 'cli_only')
    || !Array.isArray(value.plans) || value.plans.length > MAX_LISTED_PLANS) {
    fail('an invalid listing');
  }
  return { applyMode: value.applyMode, plans: value.plans.map(parseFleetLifecycleProgress) };
}

/**
 * Read a gateway lifecycle response. These are gateway-owned, operator-only
 * routes served at the unified origin before any companion Garden route: they
 * are not companion-scoped Garden data paths, so they cannot ride `apiFetch`
 * (which scopes every path to a companion Garden and refuses on /fleet), and
 * they are deliberately absent from the Garden route-capability catalogue so
 * no request capability can ever be minted for them. Each call site below
 * therefore uses a literal path and a literal init, like the other
 * `/v1/fleet*` gateway ceremonies.
 */
async function readLifecycleResponse(response: Response): Promise<unknown> {
  if (response.status === 401) {
    if (typeof window !== 'undefined') window.location.assign('/fleet/login');
    throw new FleetLifecycleRequestError('unauthorized');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const code = typeof error?.type === 'string'
      && (FLEET_LIFECYCLE_ERROR_CODES as readonly string[]).includes(error.type)
      ? error.type as FleetLifecycleErrorCode
      : 'fleet_lifecycle_unavailable';
    throw new FleetLifecycleRequestError(code, typeof error?.stageId === 'string' ? error.stageId : undefined);
  }
  return body;
}

export async function fetchFleetLifecycleListing(signal?: AbortSignal): Promise<FleetLifecycleListing> {
  const response = await fetch(LIFECYCLE_PATH, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  return parseFleetLifecycleListing(await readLifecycleResponse(response));
}

export async function requestFleetLifecyclePlan(request: unknown): Promise<FleetLifecyclePlan> {
  // Validate locally with the shared parser before anything leaves the page.
  const parsed = parseFleetLifecycleRequest(request);
  const response = await fetch(LIFECYCLE_PATH, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed),
  });
  return parseFleetLifecyclePlan(await readLifecycleResponse(response));
}

export async function applyFleetLifecyclePlan(input: {
  plan: FleetLifecyclePlan;
  confirmCompanionId: string;
  resume: boolean;
}): Promise<FleetLifecycleProgress> {
  const response = await fetch(`${LIFECYCLE_PATH}/${encodeURIComponent(input.plan.planId)}/apply`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planDigest: input.plan.digest,
      resume: input.resume,
      confirmCompanionId: input.confirmCompanionId,
    }),
  });
  return parseFleetLifecycleProgress(await readLifecycleResponse(response));
}

export const FLEET_LIFECYCLE_STAGE_LABELS: Readonly<Record<FleetLifecycleStageId, string>> = {
  verify_tenant: 'Tenant schema and role verified',
  verify_secret_refs: 'Credential references provisioned',
  verify_owner_roots: 'Owner files and character card present',
  verify_workspace: 'Workspace layout valid',
  verify_fleet_auth: 'Fleet-auth admission checked',
  verify_workload: 'Workload prerequisites checked',
  readmit_icp: 'ICP readmission',
  publish_membership: 'Roster membership published',
  fence_icp: 'ICP admission fenced, permits revoked',
  verify_fleet_auth_retired: 'Fleet-auth removal ceremony verified',
  drain_workload: 'Workload drained',
  withdraw_membership: 'Roster membership withdrawn',
};

export const FLEET_LIFECYCLE_ERROR_HELP: Readonly<Partial<Record<FleetLifecycleErrorCode, string>>> = {
  stale_topology: 'The roster changed after this plan was made. Create a new plan.',
  resume_required: 'This plan was partially applied. Resume it to continue.',
  approval_mismatch: 'The approval does not match this exact plan.',
  readmission_requires_reapproval: 'This companion was removed before. Complete fleet-auth readd and operator reinstatement, then plan with readmit.',
  fleet_auth_not_admitted: 'Fleet auth has not reapproved this companion yet.',
  fleet_auth_not_retired: 'Complete the fleet-auth companion removal ceremony first.',
  apply_requires_cli: 'This deployment applies plans through the CLI: npm run ops:fleet-lifecycle -- apply.',
  unauthorized: 'Only the fleet operator credential may change fleet membership.',
  primary_removal_unsupported: 'The primary companion cannot be removed here.',
};
