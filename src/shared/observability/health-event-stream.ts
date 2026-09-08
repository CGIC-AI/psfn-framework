// ── Bounded runtime health-event stream: port and bus sink (bead psfn-framework-7qeo1.24.1) ──
//
// The gateway, agent, and scheduler emitters publish `runtime.health.event` on
// the process bus. This module owns the two seams between that bus event and
// durable storage:
//
//   * {@link HealthEventStorePort} — the read/write surface a detector child
//     (.2-.4) and the Garden incident timeline (.6) consume. Keeping it here
//     rather than in the Postgres adapter means a detector never imports `pg`.
//   * {@link subscribeHealthEventStream} — the sink. It re-validates the
//     envelope at the persistence boundary and drops the bus event's
//     correlation metadata: that metadata is in-process routing context and
//     carries session, channel, and viewer identifiers that must never reach
//     the stream. ONLY `data.event` is persisted.
//
// The sink must be subscribed before the first emitter can fire: `EventBus.emit`
// returns silently when nothing is listening, so a late subscription loses
// startup-time observations rather than failing loudly.

import type { EventBus } from '../event-bus.js';
import { validateHealthEvent, type HealthEvent } from '../contracts/health-event.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('HealthEventStream');

/**
 * Structural ceiling on one `listRecent` page. It is a schema-shape bound, not
 * operator policy: it caps what a single read can pull into memory, and every
 * owner-file value that becomes a read limit (the detector scan limit, the
 * investigator's bundle window) is validated against it at config load so an
 * over-large owner value fails the owner file closed instead of throwing on
 * every read.
 */
export const MAX_HEALTH_EVENT_LIST_LIMIT = 1_000;

/** Read filter for the stream. Every field narrows; absence means "no filter". */
export interface HealthEventQuery {
  limit?: number;
  sinceMs?: number;
  correlationId?: string;
}

/**
 * Durable surface over the bounded health stream. `record` is idempotent on
 * `eventId` and prunes to the configured row cap; `listRecent` reads
 * newest-first and re-validates every row, so a corrupted or forward-versioned
 * row fails closed instead of reaching a detector.
 */
export interface HealthEventStorePort {
  record(event: HealthEvent): Promise<void>;
  listRecent(query?: HealthEventQuery): Promise<HealthEvent[]>;
  close(): Promise<void>;
}

/**
 * Subscribe the persisting sink to a process bus. Returns the unsubscribe
 * handle for shutdown.
 *
 * A persistence failure is logged and contained: the bus's documented telemetry
 * contract isolates subscriber errors, and a health-plane write must never
 * abort the scheduler task or startup check that was reporting a fault. The
 * failure is still surfaced — it is logged at error with the code that was
 * lost, never silently discarded.
 */
export function subscribeHealthEventStream(deps: {
  eventBus: EventBus;
  store: HealthEventStorePort;
}): () => void {
  return deps.eventBus.on('runtime.health.event', async (data) => {
    // Persist the envelope alone. Correlation metadata spread alongside it on
    // the bus stays in-process by construction.
    const event = validateHealthEvent(data.event);
    try {
      await deps.store.record(event);
    } catch (error) {
      log.error('Failed to persist runtime health event', {
        code: event.code,
        component: event.provenance.component,
        error: toErrorMessage(error),
      });
    }
  });
}
