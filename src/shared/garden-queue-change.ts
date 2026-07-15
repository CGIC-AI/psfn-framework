import type { EventBus, GardenQueueName } from './event-bus.js';
import { createComponentLogger } from './logger.js';
import { toErrorMessage } from './utils/errors.js';

const log = createComponentLogger('GardenQueueChange');

/** Emit a content-free Garden queue invalidation without blocking its writer. */
export function emitGardenQueueChanged(
  eventBus: EventBus,
  queue: GardenQueueName,
  companionId?: string,
): void {
  eventBus.emit('garden.queue.changed', {
    queue,
    ...(companionId ? { companionId } : {}),
    timestamp: Date.now(),
  }).catch((error: unknown) => {
    log.error('Failed to emit Garden queue change signal', {
      queue,
      error: toErrorMessage(error),
    });
  });
}
