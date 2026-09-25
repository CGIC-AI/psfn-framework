import { randomUUID } from 'node:crypto';
import type { ExternalChannelOutboundMessage } from './protocol.js';

class ExternalChannelOutboundQueueFull extends Error {}

/**
 * Bounded FIFO of companion-initiated messages awaiting a bridge pull. The
 * gateway only ever enqueues; a bridge that stops pulling fills its own queue
 * and further sends to it are refused, never buffered without bound.
 */
export class ExternalChannelOutboundQueue {
  readonly #capacity: number;
  readonly #items: ExternalChannelOutboundMessage[] = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  enqueue(message: Omit<ExternalChannelOutboundMessage, 'deliveryId'>): string {
    if (this.#items.length >= this.#capacity) {
      throw new ExternalChannelOutboundQueueFull(
        `outbound queue is full (${this.#capacity} messages awaiting the bridge)`,
      );
    }
    const deliveryId = randomUUID();
    this.#items.push({ deliveryId, ...message });
    return deliveryId;
  }

  drain(maxItems: number): ExternalChannelOutboundMessage[] {
    return this.#items.splice(0, maxItems);
  }

  /** Discards everything still queued and returns how many were dropped. */
  clear(): number {
    return this.#items.splice(0).length;
  }
}
