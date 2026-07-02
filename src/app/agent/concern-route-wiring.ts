import type { EventBus } from '../../shared/event-bus.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import { resolveNorthStarPath, resolveReflectionJournalPath } from '../../persistence/layout.js';
import {
  createIntrospectionRouteHandler,
  createNorthStarRouteHandler,
} from '../../core/intention/concern-route-adapters.js';
import { ConcernRouteDispatcher } from '../../core/intention/concern-route-handoff.js';

export interface CreateDefaultConcernRouteDispatcherOptions {
  companionDataDir: string;
  eventBus: EventBus;
  now?: () => Date;
}

/**
 * Wire the durable-substrate route dispatcher used by concern-candidate review
 * and nightly grooming (etj1).
 *
 * Real handlers are provided for the substrates that can accept a
 * provenance-preserving handoff without fabricating policy-sensitive identity:
 * - `north_star`      → north-star store (disabled draft for operator review)
 * - `introspection`   → reflection journal (append-only, no cap, no prompt/outbound impact)
 *
 * `project`, `reminder`, `schedule`, and `other` have no handler here, so they
 * fail closed with an explicit blocked-route event rather than fabricating a
 * channel identity or bypassing existing policy gates.
 */
export function createDefaultConcernRouteDispatcher(
  options: CreateDefaultConcernRouteDispatcherOptions,
): ConcernRouteDispatcher {
  const northStarStore = new NorthStarStore(resolveNorthStarPath(options.companionDataDir));
  const reflectionJournal = new ReflectionJournalStore(
    resolveReflectionJournalPath(options.companionDataDir),
  );
  return new ConcernRouteDispatcher({
    handlers: {
      north_star: createNorthStarRouteHandler(northStarStore),
      introspection: createIntrospectionRouteHandler(reflectionJournal),
    },
    eventBus: options.eventBus,
    ...(options.now ? { now: options.now } : {}),
  });
}
