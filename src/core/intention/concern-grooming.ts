import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ConcernStorePort } from './concern-store-port.js';
import {
  MAX_ACTIVE_CONCERNS,
  isConcernAttentionStatus,
  type ActiveConcern,
} from './concerns.js';

const CONCERN_GROOMING_TASK_ID = 'concern-grooming';
const CONCERN_GROOMING_TASK_NAME = 'Concern Grooming';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface ConcernGroomingResult {
  staleResolved: ActiveConcern[];
  capResolved: ActiveConcern[];
  activeCountBeforeCap: number;
  activeCountAfterCap: number;
}

export interface GroomConcernSetOptions {
  concernStore: ConcernStorePort;
  asOf?: string;
  maxActiveConcerns?: number;
}

export async function groomConcernSet(options: GroomConcernSetOptions): Promise<ConcernGroomingResult> {
  const asOf = normalizeAsOf(options.asOf);
  const staleResolved = await options.concernStore.resolveStaleConcerns({
    asOf,
    limit: 200,
    evidenceRefs: [{ kind: 'runtime', ref: `concern-grooming:stale:${asOf}` }],
    outcome: 'Retired from the short-time concern set after the review window elapsed.',
  });

  const maxActiveConcerns = normalizeMaxActiveConcerns(options.maxActiveConcerns);
  const activeAfterStale = (await options.concernStore.list({
    includeResolved: false,
    includeExpired: false,
    asOf,
    limit: 200,
  })).filter(concern => isConcernAttentionStatus(concern.status));

  const activeCountBeforeCap = activeAfterStale.length;
  const kept = selectConcernsToKeep(activeAfterStale, maxActiveConcerns);
  const keptIds = new Set(kept.map(concern => concern.id));
  const overflow = activeAfterStale.filter(concern => !keptIds.has(concern.id));
  const capResolved: ActiveConcern[] = [];
  for (const concern of overflow) {
    const resolved = await options.concernStore.resolveConcern(concern.id, {
      outcome: 'Retired from concerns for durable tracking review because the active concern cap was reached.',
      resolvedAt: asOf,
      evidenceRefs: [{ kind: 'runtime', ref: `concern-grooming:cap:${asOf}` }],
    });
    if (resolved) capResolved.push(resolved);
  }

  return {
    staleResolved,
    capResolved,
    activeCountBeforeCap,
    activeCountAfterCap: Math.min(activeCountBeforeCap, maxActiveConcerns),
  };
}

export interface RegisterConcernGroomingTaskOptions {
  scheduler: Scheduler;
  concernStore: ConcernStorePort;
  eventBus?: EventBus | null;
  intervalMs?: number;
}

export function registerConcernGroomingTask(options: RegisterConcernGroomingTaskOptions): void {
  if (options.scheduler.getTask(CONCERN_GROOMING_TASK_ID)) {
    return;
  }
  options.scheduler.register({
    id: CONCERN_GROOMING_TASK_ID,
    name: CONCERN_GROOMING_TASK_NAME,
    type: 'every',
    intervalMs: options.intervalMs ?? ONE_DAY_MS,
    cadence: { kind: 'daily', hour: 6, minute: 15, timezone: 'local' },
    handler: async () => {
      const result = await groomConcernSet({ concernStore: options.concernStore });
      await options.eventBus?.emit('intention.concern.groomed', {
        staleResolvedCount: result.staleResolved.length,
        capResolvedCount: result.capResolved.length,
        activeCountBeforeCap: result.activeCountBeforeCap,
        activeCountAfterCap: result.activeCountAfterCap,
        timestamp: Date.now(),
      });
    },
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  }, { skipFirstRun: true });
}

function normalizeAsOf(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Concern grooming asOf must be a valid ISO timestamp');
  }
  return new Date(parsed).toISOString();
}

function normalizeMaxActiveConcerns(value: number | undefined): number {
  if (value === undefined) return MAX_ACTIVE_CONCERNS;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Concern grooming maxActiveConcerns must be a positive number');
  }
  return Math.floor(value);
}

function selectConcernsToKeep(
  concerns: readonly ActiveConcern[],
  maxActiveConcerns: number,
): ActiveConcern[] {
  return [...concerns]
    .sort((left, right) => (
      priorityRank(left.priority) - priorityRank(right.priority)
      || Date.parse(left.expiresAt) - Date.parse(right.expiresAt)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || right.salience - left.salience
      || left.id.localeCompare(right.id)
    ))
    .slice(0, maxActiveConcerns);
}

function priorityRank(priority: ActiveConcern['priority']): number {
  if (priority === 'high') return 0;
  if (priority === 'medium') return 1;
  return 2;
}
