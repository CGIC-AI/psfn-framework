import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { ForeignSessionReadAuditSink } from './foreign-session-read-audit.js';

const log = createComponentLogger('SessionManager');

/**
 * ls15s: foreign captured-session reads are admitted only with an audit
 * channel. Without an event bus every foreign read is refused (null sink);
 * with one, the content-free event is dispatched before the read and a later
 * asynchronous delivery failure is logged, never swallowed.
 */
export function createEventBusForeignSessionReadAuditSink(
  eventBus: EventBus | null,
): ForeignSessionReadAuditSink | null {
  if (!eventBus) return null;
  return (event) => {
    eventBus.emit('session.foreign_read.audited', event).catch((error: unknown) => {
      log.error('Foreign session read audit event delivery failed', {
        reason: event.reason,
        sourceSessionRef: event.sourceSessionRef,
        targetSessionRef: event.targetSessionRef,
        error: toErrorMessage(error),
      });
    });
  };
}
