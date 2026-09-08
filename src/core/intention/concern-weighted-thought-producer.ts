// ── Concern-derived weighted thoughts (Charter 6.24 / psfn-framework-99ugi) ──
//
// A weighted thought is how a live concern keeps competing for attention after
// the turn that raised it: it accumulates, decays, and — when the concern's
// resolution contradicts the person's surface closure — is DAMPENED rather than
// zeroed by `applyWeightedThoughtContradictionDampening`.
//
// That dampening is concern-scoped: it only reduces thoughts whose
// `provenance.concernId` names the resolving concern. This module is the
// producer that stamps that provenance. Without it the scoping filter matches
// nothing and the guard is inert, and the concern's own care never reaches the
// weighted-thought lifecycle at all.
//
// Both production concern-creation paths reach it: the extraction-derived
// candidate review (`intention.concern_candidate.reviewed`) and the post-turn
// appraisal decision (`intention.concern.created`). Covering only one would
// leave the dampening guard inert for the concerns raised by the other.
//
// Shape mirrors the ICP co-location adapter: an event subscriber that performs
// exactly one authoritative re-read and one durable thought write, with no
// model, broker or scheduler dependency.
//
// Fail closed: a concern that vanished, is no longer in an attention status, or
// has no canonical contact produces NO thought. A concern-provenance thought is
// outreach-eligible, and the outbound gate re-verifies concern liveness at
// dispatch — so a thought is only ever minted from a concern that is live at
// this moment, never inferred from the review outcome alone.

import { createComponentLogger } from '../../shared/logger.js';
import type { EventMap } from '../../shared/event-bus.js';
import { isConcernAttentionStatus, type ActiveConcern } from './concerns.js';
import {
  recordWeightedThought,
  type WeightedThoughtStorePort,
} from './weighted-thought-store-port.js';
import type {
  ThoughtProvenance,
  WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';

const log = createComponentLogger('ConcernWeightedThought');

/** Concern-review outcomes that mean a live concern now exists to care about. */
const CONCERN_CREATING_STATUSES: readonly string[] = ['created', 'merged'];

const CONCERN_THOUGHT_SOURCE = 'concern';

export type ConcernCandidateReviewedEvent = EventMap['intention.concern_candidate.reviewed'];
export type ConcernCreatedEvent = EventMap['intention.concern.created'];

export interface ConcernWeightedThoughtProducerDeps {
  concernStore: { getById(id: string): Promise<ActiveConcern | null> | ActiveConcern | null };
  thoughtStore: Pick<WeightedThoughtStorePort, 'getById' | 'save'>;
  lifecycleConfig: WeightedThoughtLifecycleConfig;
  now?: () => number;
  logger?: Pick<ReturnType<typeof createComponentLogger>, 'warn' | 'debug'>;
}

export interface ConcernWeightedThoughtResult {
  /** Ids of the thoughts created or reinforced by this event. */
  recordedThoughtIds: string[];
}

/**
 * The durable id one concern's thought is keyed by. Stable across reviews, so a
 * concern reviewed again reinforces its existing thought (recency + a fresh
 * increment) instead of forking a duplicate.
 */
export function concernWeightedThoughtId(concernId: string): string {
  return `concern:${concernId}`;
}

function concernThoughtProvenance(concern: ActiveConcern): ThoughtProvenance {
  return {
    // LIVE provenance: the outreach resolver routes on it and the outbound gate
    // re-verifies the concern is still active at dispatch time.
    concernId: concern.id,
    ...(concern.originIcpRootInitiationId
      ? { icpRootInitiationId: concern.originIcpRootInitiationId }
      : {}),
  };
}

/**
 * Record one weighted thought per named concern. Each concern is re-read from
 * its authoritative store — an event names a concern, it never describes its
 * current state, and only a concern that is live right now becomes a thought.
 */
async function recordThoughtsForConcerns(
  deps: ConcernWeightedThoughtProducerDeps,
  concernIds: readonly string[],
): Promise<ConcernWeightedThoughtResult> {
  const logger = deps.logger ?? log;
  const now = deps.now ?? Date.now;

  const recordedThoughtIds: string[] = [];
  for (const concernId of concernIds) {
    const concern = await deps.concernStore.getById(concernId);
    if (!concern) {
      logger.warn('Concern thought skipped: named concern not found', { concernId });
      continue;
    }
    if (!isConcernAttentionStatus(concern.status)) {
      logger.debug('Concern thought skipped: concern is not in an attention status', {
        concernId,
        status: concern.status,
      });
      continue;
    }
    if (!concern.contactId) {
      // Dampening and outreach are both contact-scoped; a contact-less concern
      // has nothing to scope to, so it never becomes a weighted thought.
      logger.debug('Concern thought skipped: concern has no canonical contact', { concernId });
      continue;
    }
    const thought = await recordWeightedThought(
      deps.thoughtStore,
      deps.lifecycleConfig,
      {
        id: concernWeightedThoughtId(concern.id),
        content: concern.text,
        source: CONCERN_THOUGHT_SOURCE,
        thoughtClass: 'standard',
        contactId: concern.contactId,
        provenance: concernThoughtProvenance(concern),
        // Emotional charge is the concern's own formation arousal when one was
        // snapshotted; absence stays absence rather than an invented default.
        ...(concern.formationVAD
          ? { emotionalIntensity: concern.formationVAD.arousal }
          : {}),
      },
      now(),
    );
    recordedThoughtIds.push(thought.id);
  }

  if (recordedThoughtIds.length > 0) {
    logger.debug('Recorded concern-derived weighted thoughts', {
      namedConcernCount: concernIds.length,
      recordedCount: recordedThoughtIds.length,
    });
  }
  return { recordedThoughtIds };
}

/** Concerns one candidate-review batch actually brought into being. */
export async function recordConcernWeightedThoughts(
  deps: ConcernWeightedThoughtProducerDeps,
  event: ConcernCandidateReviewedEvent,
): Promise<ConcernWeightedThoughtResult> {
  return await recordThoughtsForConcerns(deps, [...new Set(
    event.outcomes
      .filter(outcome => CONCERN_CREATING_STATUSES.includes(outcome.status))
      .map(outcome => outcome.concernId)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  )]);
}

/** One concern raised directly by a post-turn appraisal decision. */
export async function recordCreatedConcernWeightedThought(
  deps: ConcernWeightedThoughtProducerDeps,
  event: ConcernCreatedEvent,
): Promise<ConcernWeightedThoughtResult> {
  return await recordThoughtsForConcerns(deps, [event.concernId]);
}

/**
 * Build the `intention.concern_candidate.reviewed` subscriber that keeps every
 * live concern represented in the weighted-thought lifecycle. Mount it with
 * `eventBus.on('intention.concern_candidate.reviewed', …)`.
 */
export function createConcernWeightedThoughtProducer(
  deps: ConcernWeightedThoughtProducerDeps,
): (event: ConcernCandidateReviewedEvent) => Promise<void> {
  return async (event) => {
    await recordConcernWeightedThoughts(deps, event);
  };
}

/**
 * The same producer for the appraisal path. Mount it with
 * `eventBus.on('intention.concern.created', …)`.
 */
export function createCreatedConcernWeightedThoughtProducer(
  deps: ConcernWeightedThoughtProducerDeps,
): (event: ConcernCreatedEvent) => Promise<void> {
  return async (event) => {
    await recordCreatedConcernWeightedThought(deps, event);
  };
}
