// ── Memory/wiki refresh-failure health emitter (bead psfn-framework-7qeo1.24.3) ──
//
// The context-refresh lanes already announce their own degradation on the bus,
// but they announce it with the CONTENT the operator log needs: a channel id, a
// cache key, the rendered error. None of that may enter the health stream, and
// none of it is what a detector needs — a detector needs to know that the SAME
// LANE failed again.
//
// So this projects each degradation into one content-free observation whose only
// identity is a digest of the lane. Repeated failures of the memory
// active-context refresh therefore accumulate in one group no matter which
// channel triggered them, which is exactly the grouping bead .3's "one incident
// per lane episode" is defined over.
//
// Two sources, chosen deliberately:
//
//   * `memory.active_context.refresh` with `phase: 'degraded'` is per REFRESH:
//     one observation per failed refresh, which is the honest failure count.
//   * `wiki.retrieval.turn_degraded` with `reason: 'refresh_failed'` is the only
//     signal the wiki lane publishes for a failed refresh, and it fires per
//     degraded TURN. Its count is therefore an upper bound on refresh failures
//     rather than an exact one — it is kept because a wiki lane stuck in
//     `refresh_failed` is a real incident, and it is grouped separately so it
//     can never inflate the memory lane's count.
//
// A subscription failure here must never break a turn: the bus isolates
// subscriber errors, and this logs rather than rethrows for the same reason
// every other health emitter does.

import type { EventBus } from '../event-bus.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEventSource,
} from '../contracts/health-event.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('RefreshFailureHealth');

/**
 * The refresh lanes, as opaque grouping keys. Naming them here rather than at
 * each call site is what guarantees the digest is stable across releases: the
 * group would silently split if two emitters spelled the same lane differently.
 */
const REFRESH_LANE_SUBJECTS = {
  activeContext: 'memory_refresh:active_context',
  wikiRetrieval: 'memory_refresh:wiki_retrieval',
} as const;

/**
 * Subscribe the refresh-failure projection to a process bus. Returns the
 * unsubscribe handles' combined detach, matching `subscribeHealthEventStream`.
 */
export function subscribeRefreshFailureHealthEvents(deps: {
  eventBus: EventBus;
  source: HealthEventSource;
}): () => void {
  const emit = async (lane: string, observedAtMs: number): Promise<void> => {
    try {
      await emitHealthEvent(deps.eventBus, {
        owner: deps.source.owner,
        severity: 'warning',
        code: 'memory_refresh_failed',
        provenance: {
          process: deps.source.process,
          component: 'memory',
          observerId: processObserverId(),
          subjectHash: hashHealthEventSubject(lane),
        },
        observedAtMs,
      });
    } catch (error) {
      log.error('Refresh-failure health event emission failed', {
        error: toErrorMessage(error),
      });
    }
  };

  const detachActiveContext = deps.eventBus.on('memory.active_context.refresh', async (payload) => {
    if (payload.phase !== 'degraded') return;
    await emit(REFRESH_LANE_SUBJECTS.activeContext, payload.timestamp);
  });
  const detachWiki = deps.eventBus.on('wiki.retrieval.turn_degraded', async (payload) => {
    if (payload.reason !== 'refresh_failed') return;
    await emit(REFRESH_LANE_SUBJECTS.wikiRetrieval, payload.timestamp);
  });

  return () => {
    detachActiveContext();
    detachWiki();
  };
}
