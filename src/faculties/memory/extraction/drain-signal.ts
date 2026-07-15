import type { ExtractionTriggerReason } from './types.js';

/**
 * Raised when a durable, receipt-bound bounded extraction that was queued behind
 * other same-session work (serialize scheduling) finds the extractor draining
 * (`acceptingExtractions === false`) by the time its serialized run finally
 * starts, or drains mid-flight before any fact is written.
 *
 * It is thrown BEFORE the effect boundary is crossed (or, for a mid-flight
 * drain, before any write is attempted) and BEFORE coverage is advanced, so the
 * queued durable work fails closed — retryable — instead of resolving as a
 * covered no-op. Resolving normally on drain is the silent-loss bug this signal
 * closes: `maybeExtract` would mark the snapshot covered and the background
 * effect receipt would complete `applied` without ever writing its facts.
 *
 * The post-turn background seam translates this into a retryable defer
 * (`BackgroundWorkDeferredError('source_not_ready')`), so the job and its effect
 * receipt stay eligible for a later run whose exact snapshot advances coverage
 * only after it succeeds. Only receipt-bound runs raise it; foreground, manual,
 * and group extractions keep their intentional silent skip on drain.
 */
export class ExtractionDrainRequeueError extends Error {
  readonly channelId: string;
  readonly triggerReason: ExtractionTriggerReason;

  constructor(channelId: string, triggerReason: ExtractionTriggerReason) {
    super(
      `Durable bounded extraction requeued: extractor draining before its serialized run wrote any fact (${channelId}:${triggerReason})`,
    );
    this.name = 'ExtractionDrainRequeueError';
    this.channelId = channelId;
    this.triggerReason = triggerReason;
  }
}
