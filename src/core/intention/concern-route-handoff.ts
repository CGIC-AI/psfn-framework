import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ConcernCandidateRouteTarget } from './concern-candidates.js';
import type { ActiveConcernEvidenceRef, ActiveConcernPriority } from './concerns.js';

const log = createComponentLogger('ConcernRouteHandoff');

export type Awaitable<T> = T | Promise<T>;

/**
 * Canonical route target set. Kept structurally identical to
 * {@link ConcernCandidateRouteTarget} so review decisions and grooming share
 * one durable-handoff vocabulary.
 */
export type ConcernRouteTarget = ConcernCandidateRouteTarget;

/**
 * Where the route request originated. Preserving provenance keeps blocked and
 * routed outcomes attributable across near-turn review and nightly grooming.
 */
export type ConcernRouteSource =
  | 'candidate_review'
  | 'grooming_cap_overflow'
  | 'grooming_stale';

export type ConcernRouteDisposition = 'routed' | 'blocked';

/** Fallback channel id for substrates that require a channel tag but where the
 *  routed item carries no channel identity (e.g. grooming ActiveConcerns). */
export const CONCERN_ROUTE_SYSTEM_CHANNEL_ID = 'system:intention';

export interface ConcernRouteRequest {
  target: ConcernRouteTarget;
  source: ConcernRouteSource;
  title: string;
  summary: string;
  priority: ActiveConcernPriority;
  reason: string;
  evidenceRefs: readonly ActiveConcernEvidenceRef[];
  channelId?: string;
  contactId?: string;
  dueAt?: string;
  candidateId?: string;
  concernId?: string;
}

export interface ConcernRouteHandlerResult {
  disposition: ConcernRouteDisposition;
  /** Substrate identifier the handler owns, e.g. 'north_star'. */
  substrate: string;
  /** Durable id created/updated in the destination substrate, when routed. */
  targetRef?: string;
  reason: string;
}

export interface ConcernRouteOutcome extends ConcernRouteHandlerResult {
  target: ConcernRouteTarget;
  source: ConcernRouteSource;
  candidateId?: string;
  concernId?: string;
}

/**
 * A durable substrate adapter. Implementations should fail closed by returning a
 * `blocked` result rather than throwing; the dispatcher additionally guards
 * against thrown errors so a routing failure never reopens a concern.
 */
export interface ConcernRouteHandler {
  readonly substrate: string;
  route(request: ConcernRouteRequest): Awaitable<ConcernRouteHandlerResult>;
}

export type ConcernRouteHandlerMap = Partial<Record<ConcernRouteTarget, ConcernRouteHandler>>;

export interface ConcernRouteDispatcherOptions {
  handlers: ConcernRouteHandlerMap;
  eventBus?: EventBus | null;
  now?: () => Date;
}

/**
 * Maps a route target to its configured durable handler. Missing handlers,
 * blocked handler results, and thrown handler errors all resolve to an explicit
 * `blocked` outcome with a typed event; nothing is silently dropped and no
 * outbound delivery is performed.
 */
export class ConcernRouteDispatcher {
  private readonly handlers: ConcernRouteHandlerMap;
  private readonly eventBus: EventBus | null;
  private readonly now: () => Date;

  constructor(options: ConcernRouteDispatcherOptions) {
    this.handlers = { ...options.handlers };
    this.eventBus = options.eventBus ?? null;
    this.now = options.now ?? (() => new Date());
  }

  hasHandler(target: ConcernRouteTarget): boolean {
    return Boolean(this.handlers[target]);
  }

  async dispatch(request: ConcernRouteRequest): Promise<ConcernRouteOutcome> {
    const handler = this.handlers[request.target];
    if (!handler) {
      return this.finalize(request, {
        disposition: 'blocked',
        substrate: 'none',
        reason: `blocked route: no handler for target ${request.target}`,
      });
    }
    try {
      const result = await handler.route(request);
      return this.finalize(request, result);
    } catch (error) {
      // Fail closed: a thrown adapter error becomes a blocked outcome. We never
      // rethrow, so a routing failure cannot reopen or lose the source item.
      log.warn('Concern route handler threw; treating as blocked', {
        target: request.target,
        source: request.source,
        substrate: handler.substrate,
        error: String(error),
      });
      return this.finalize(request, {
        disposition: 'blocked',
        substrate: handler.substrate,
        reason: `blocked route: handler for ${request.target} failed (${errorMessage(error)})`,
      });
    }
  }

  private finalize(
    request: ConcernRouteRequest,
    result: ConcernRouteHandlerResult,
  ): ConcernRouteOutcome {
    const outcome: ConcernRouteOutcome = {
      ...result,
      target: request.target,
      source: request.source,
      ...(request.candidateId ? { candidateId: request.candidateId } : {}),
      ...(request.concernId ? { concernId: request.concernId } : {}),
    };
    this.emit(outcome);
    return outcome;
  }

  private emit(outcome: ConcernRouteOutcome): void {
    if (!this.eventBus) return;
    const timestamp = this.now().getTime();
    const emitted = outcome.disposition === 'routed'
      ? this.eventBus.emit('intention.concern.routed', {
          target: outcome.target,
          source: outcome.source,
          substrate: outcome.substrate,
          reason: outcome.reason,
          ...(outcome.targetRef ? { targetRef: outcome.targetRef } : {}),
          ...(outcome.candidateId ? { candidateId: outcome.candidateId } : {}),
          ...(outcome.concernId ? { concernId: outcome.concernId } : {}),
          timestamp,
        })
      : this.eventBus.emit('intention.concern.route_blocked', {
          target: outcome.target,
          source: outcome.source,
          substrate: outcome.substrate,
          reason: outcome.reason,
          ...(outcome.candidateId ? { candidateId: outcome.candidateId } : {}),
          ...(outcome.concernId ? { concernId: outcome.concernId } : {}),
          timestamp,
        });
    void Promise.resolve(emitted).catch((error: unknown) => {
      log.warn('Concern route event emit failed', { error: String(error) });
    });
  }
}

/**
 * Normalize evidence refs (plus candidate/concern provenance) into the flat
 * string list durable substrates use for provenance tracking.
 */
export function concernRouteProvenanceRefs(request: ConcernRouteRequest): string[] {
  const refs = request.evidenceRefs.map(ref => `${ref.kind}:${ref.ref}`);
  if (request.candidateId) refs.push(`candidate:${request.candidateId}`);
  if (request.concernId) refs.push(`concern:${request.concernId}`);
  refs.push(`route-source:${request.source}`);
  return [...new Set(refs.filter(ref => ref.trim().length > 0))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
