import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import {
  digestFleetLifecyclePlan,
  FLEET_LIFECYCLE_ADD_STAGES,
  FLEET_LIFECYCLE_ERROR_CODES,
  FLEET_LIFECYCLE_REMOVE_STAGES,
  FleetLifecycleError,
  type FleetLifecycleFailure,
  type FleetLifecyclePlan,
  type FleetLifecycleProgress,
  type FleetLifecycleReceipt,
  type FleetLifecycleStageId,
} from './contracts.js';

const OWNER_ONLY_FILE_MODE = 0o600;
const STAGE_IDS: readonly string[] = [...FLEET_LIFECYCLE_ADD_STAGES, ...FLEET_LIFECYCLE_REMOVE_STAGES];
const RECEIPT_OUTCOMES: readonly string[] = [
  'verified', 'applied', 'already_satisfied', 'fleet_auth_disabled', 'restart_required', 'helm_upgrade_required',
];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Durable plans, per-stage receipts, and the latest stage failure under
 * `<systemDataDir>/fleet-lifecycle/plans/<planId>/`. A receipt is written only
 * after its stage returned, so a crash replays at most the interrupted stage,
 * and every stage is idempotent.
 */
export class FleetLifecyclePlanStore {
  private readonly root: string;

  constructor(systemDataDir: string) {
    this.root = join(systemDataDir, 'fleet-lifecycle', 'plans');
  }

  private planDir(planId: string): string {
    if (!isRfc4122Uuid(planId)) throw new FleetLifecycleError('plan_not_found', 'Plan id must be a UUID');
    return join(this.root, planId);
  }

  savePlan(plan: FleetLifecyclePlan): void {
    const path = join(this.planDir(plan.planId), 'plan.json');
    if (existsSync(path)) throw new FleetLifecycleError('invalid_request', 'Plan id already exists');
    writeJsonAtomic(path, plan, { mode: OWNER_ONLY_FILE_MODE });
  }

  loadPlan(planId: string): FleetLifecyclePlan {
    const path = join(this.planDir(planId), 'plan.json');
    if (!existsSync(path)) throw new FleetLifecycleError('plan_not_found', 'No such lifecycle plan');
    const value = readJson(path);
    if (!isRecord(value) || value.planId !== planId || typeof value.digest !== 'string'
      || !Array.isArray(value.stages) || value.stages.some(stage => !STAGE_IDS.includes(String(stage)))) {
      throw new FleetLifecycleError('plan_integrity_failed', 'Stored lifecycle plan is malformed');
    }
    const { digest, ...body } = value as unknown as FleetLifecyclePlan;
    if (digestFleetLifecyclePlan(body) !== digest) {
      throw new FleetLifecycleError('plan_integrity_failed', 'Stored lifecycle plan digest does not match its content');
    }
    return value as unknown as FleetLifecyclePlan;
  }

  recordReceipt(receipt: FleetLifecycleReceipt): void {
    writeJsonAtomic(
      join(this.planDir(receipt.planId), 'receipts', `${receipt.stageId}.json`),
      receipt,
      { mode: OWNER_ONLY_FILE_MODE },
    );
  }

  receipts(plan: FleetLifecyclePlan): FleetLifecycleReceipt[] {
    const receipts: FleetLifecycleReceipt[] = [];
    for (const stageId of plan.stages) {
      const path = join(this.planDir(plan.planId), 'receipts', `${stageId}.json`);
      if (!existsSync(path)) continue;
      const value = readJson(path);
      if (!isRecord(value) || value.planId !== plan.planId || value.stageId !== stageId
        || !RECEIPT_OUTCOMES.includes(String(value.outcome)) || typeof value.at !== 'string') {
        throw new FleetLifecycleError('plan_integrity_failed', 'Stored lifecycle receipt is malformed');
      }
      receipts.push(value as unknown as FleetLifecycleReceipt);
    }
    return receipts;
  }

  recordFailure(failure: FleetLifecycleFailure): void {
    writeJsonAtomic(join(this.planDir(failure.planId), 'failure.json'), failure, { mode: OWNER_ONLY_FILE_MODE });
  }

  failure(planId: string): FleetLifecycleFailure | undefined {
    const path = join(this.planDir(planId), 'failure.json');
    if (!existsSync(path)) return undefined;
    const value = readJson(path);
    if (!isRecord(value) || value.planId !== planId
      || !STAGE_IDS.includes(String(value.stageId))
      || !(FLEET_LIFECYCLE_ERROR_CODES as readonly string[]).includes(String(value.code))) {
      throw new FleetLifecycleError('plan_integrity_failed', 'Stored lifecycle failure is malformed');
    }
    return value as unknown as FleetLifecycleFailure;
  }

  progress(planId: string): FleetLifecycleProgress {
    const plan = this.loadPlan(planId);
    const receipts = this.receipts(plan);
    const failure = this.failure(planId);
    const completed = new Set<FleetLifecycleStageId>(receipts.map(receipt => receipt.stageId));
    const status = plan.stages.every(stage => completed.has(stage))
      ? 'applied'
      : failure && !completed.has(failure.stageId)
        ? 'failed'
        : receipts.length > 0 ? 'in_progress' : 'planned';
    return Object.freeze({
      plan,
      status,
      receipts: Object.freeze(receipts),
      ...(status === 'failed' && failure ? { failure } : {}),
    });
  }

  listPlanIds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => isRfc4122Uuid(name)).sort();
  }
}
