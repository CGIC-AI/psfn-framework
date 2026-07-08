import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ConcernStorePort } from './concern-store-port.js';
import type {
  ConcernRouteDispatcher,
  ConcernRouteOutcome,
  ConcernRouteRequest,
  ConcernRouteSource,
  ConcernRouteTarget,
} from './concern-route-handoff.js';
import {
  MAX_ACTIVE_CONCERNS,
  isConcernAttentionStatus,
  type ActiveConcern,
} from './concerns.js';

const CONCERN_GROOMING_TASK_ID = 'concern-grooming';
const CONCERN_GROOMING_TASK_NAME = 'Concern Grooming';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GROOMING_ROUTE_TARGET: ConcernRouteTarget = 'introspection';
const STALE_RESOLUTION_OUTCOME =
  'Retired from the short-time concern set after the review window elapsed.';
const CAP_RESOLUTION_OUTCOME =
  'Retired from concerns for durable tracking review because the active concern cap was reached.';

export interface ConcernGroomingResult {
  staleResolved: ActiveConcern[];
  capResolved: ActiveConcern[];
  activeCountBeforeCap: number;
  activeCountAfterCap: number;
  /**
   * Route outcomes for retired concerns (etj1). Each retired concern produces a
   * concrete routed handoff or an explicit blocked-route result rather than a
   * free-text resolution that silently disappears. Empty when no dispatcher is
   * configured.
   */
  routeOutcomes: ConcernRouteOutcome[];
}

export interface GroomConcernSetOptions {
  concernStore: ConcernStorePort;
  asOf?: string;
  maxActiveConcerns?: number;
  /** Durable-substrate dispatcher for retired concerns (etj1). */
  routeDispatcher?: ConcernRouteDispatcher;
  /** Target substrate for retired concerns; defaults to introspection. */
  routeTarget?: ConcernRouteTarget;
}

export async function groomConcernSet(options: GroomConcernSetOptions): Promise<ConcernGroomingResult> {
  const asOf = normalizeAsOf(options.asOf);
  const staleResolved = await options.concernStore.resolveStaleConcerns({
    asOf,
    limit: 200,
    evidenceRefs: [{ kind: 'runtime', ref: `concern-grooming:stale:${asOf}` }],
    outcome: STALE_RESOLUTION_OUTCOME,
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
      outcome: CAP_RESOLUTION_OUTCOME,
      resolvedAt: asOf,
      evidenceRefs: [{ kind: 'runtime', ref: `concern-grooming:cap:${asOf}` }],
    });
    if (resolved) capResolved.push(resolved);
  }

  // etj1: each retired concern becomes a concrete durable route (or an explicit
  // blocked-route result) instead of a free-text resolution. The concern stays
  // resolved regardless — routing failure never reopens it.
  const routeOutcomes = await routeRetiredConcerns({
    ...(options.routeDispatcher ? { routeDispatcher: options.routeDispatcher } : {}),
    routeTarget: options.routeTarget ?? DEFAULT_GROOMING_ROUTE_TARGET,
    staleResolved,
    capResolved,
  });

  return {
    staleResolved,
    capResolved,
    activeCountBeforeCap,
    activeCountAfterCap: Math.min(activeCountBeforeCap, maxActiveConcerns),
    routeOutcomes,
  };
}

async function routeRetiredConcerns(input: {
  routeDispatcher?: ConcernRouteDispatcher;
  routeTarget: ConcernRouteTarget;
  staleResolved: readonly ActiveConcern[];
  capResolved: readonly ActiveConcern[];
}): Promise<ConcernRouteOutcome[]> {
  if (!input.routeDispatcher) {
    return [];
  }
  const outcomes: ConcernRouteOutcome[] = [];
  for (const concern of input.staleResolved) {
    outcomes.push(await input.routeDispatcher.dispatch(
      buildConcernRouteRequest(concern, 'grooming_stale', input.routeTarget, STALE_RESOLUTION_OUTCOME),
    ));
  }
  for (const concern of input.capResolved) {
    outcomes.push(await input.routeDispatcher.dispatch(
      buildConcernRouteRequest(concern, 'grooming_cap_overflow', input.routeTarget, CAP_RESOLUTION_OUTCOME),
    ));
  }
  return outcomes;
}

function buildConcernRouteRequest(
  concern: ActiveConcern,
  source: ConcernRouteSource,
  target: ConcernRouteTarget,
  reason: string,
): ConcernRouteRequest {
  return {
    target,
    source,
    title: deriveConcernTitle(concern.text),
    summary: concern.text,
    priority: concern.priority,
    reason,
    evidenceRefs: concern.evidenceRefs,
    ...(concern.contactId ? { contactId: concern.contactId } : {}),
    concernId: concern.id,
  };
}

function deriveConcernTitle(text: string): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  return compacted.length <= 78 ? compacted : `${compacted.slice(0, 75).trim()}...`;
}

export interface RegisterConcernGroomingTaskOptions {
  scheduler: Scheduler;
  concernStore: ConcernStorePort;
  eventBus?: EventBus | null;
  intervalMs?: number;
  /** Durable-substrate dispatcher for retired concerns (etj1). */
  routeDispatcher?: ConcernRouteDispatcher;
  /** Target substrate for retired concerns; defaults to introspection. */
  routeTarget?: ConcernRouteTarget;
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
      const result = await groomConcernSet({
        concernStore: options.concernStore,
        ...(options.routeDispatcher ? { routeDispatcher: options.routeDispatcher } : {}),
        ...(options.routeTarget ? { routeTarget: options.routeTarget } : {}),
      });
      const routedCount = result.routeOutcomes.filter(o => o.disposition === 'routed').length;
      const blockedRouteCount = result.routeOutcomes.filter(o => o.disposition === 'blocked').length;
      await options.eventBus?.emit('intention.concern.groomed', {
        staleResolvedCount: result.staleResolved.length,
        capResolvedCount: result.capResolved.length,
        activeCountBeforeCap: result.activeCountBeforeCap,
        activeCountAfterCap: result.activeCountAfterCap,
        routedCount,
        blockedRouteCount,
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
