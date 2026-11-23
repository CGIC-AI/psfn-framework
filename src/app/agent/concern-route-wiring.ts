import type { EventBus } from '../../shared/event-bus.js';
import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import { resolveNorthStarPath } from '../../persistence/layout.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import type { PendingFollowUpStorePort } from '../../core/intention/pending-follow-up-store-port.js';
import {
  createNorthStarRouteHandler,
  createPendingFollowUpConcernRouteHandler,
} from '../../core/intention/concern-route-adapters.js';
import { ConcernRouteDispatcher } from '../../core/intention/concern-route-handoff.js';

export interface CreateDefaultConcernRouteDispatcherOptions {
  companionDataDir: string;
  eventBus: EventBus;
  pendingFollowUpStore?: Pick<PendingFollowUpStorePort, 'enqueue'>;
  sessionActivity?: {
    getSessionActivity(channelId: string): { channelId: string; channelType?: string } | null;
  };
  now?: () => Date;
}

/**
 * Wire the durable-substrate route dispatcher used by concern-candidate review
 * and nightly grooming (etj1).
 *
 * Real handlers are provided for the substrates that can accept a
 * provenance-preserving handoff without fabricating policy-sensitive identity:
 * - `north_star`      → north-star store (disabled draft for operator review)
 *
 * `reminder` and `schedule` share the canonical pending-follow-up substrate
 * when its Postgres port and authoritative session metadata are both wired.
 * `introspection` no longer writes `concern_route` overflow entries into
 * `reflection-journal.jsonl` (psfn-framework-b3h5p.1); retired concerns remain
 * durably recorded in the concern store. `project`, `introspection`, and
 * `other` remain explicit blocked routes.
 */
export function createDefaultConcernRouteDispatcher(
  options: CreateDefaultConcernRouteDispatcherOptions,
): ConcernRouteDispatcher {
  const { pendingFollowUpStore, sessionActivity } = options;
  if (Boolean(pendingFollowUpStore) !== Boolean(sessionActivity)) {
    throw new Error(
      'Concern pending-follow-up routing requires both pendingFollowUpStore and sessionActivity',
    );
  }
  const northStarStore = new NorthStarStore(resolveNorthStarPath(options.companionDataDir));
  const pendingFollowUpHandler = pendingFollowUpStore && sessionActivity
    ? createPendingFollowUpConcernRouteHandler({
        pendingFollowUpStore,
        resolveChannelType: channelId => resolveConcernRouteChannelType(
          sessionActivity,
          channelId,
        ),
        ...(options.now ? { now: options.now } : {}),
      })
    : undefined;
  return new ConcernRouteDispatcher({
    handlers: {
      north_star: createNorthStarRouteHandler(northStarStore),
      ...(pendingFollowUpHandler
        ? {
            reminder: pendingFollowUpHandler,
            schedule: pendingFollowUpHandler,
          }
        : {}),
    },
    eventBus: options.eventBus,
    ...(options.now ? { now: options.now } : {}),
  });
}

function resolveConcernRouteChannelType(
  sessionActivity: NonNullable<CreateDefaultConcernRouteDispatcherOptions['sessionActivity']>,
  channelId: string,
): ChannelType | null {
  const activity = sessionActivity.getSessionActivity(channelId);
  const persistedType = activity?.channelType?.trim();
  if (persistedType) {
    return CHANNEL_TYPES.includes(persistedType as ChannelType)
      ? persistedType as ChannelType
      : null;
  }
  const inferred = inferSessionChannelType(activity?.channelId ?? channelId);
  return inferred && CHANNEL_TYPES.includes(inferred as ChannelType)
    ? inferred as ChannelType
    : null;
}
