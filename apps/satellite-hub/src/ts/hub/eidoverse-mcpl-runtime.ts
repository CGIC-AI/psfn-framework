/**
 * Push-driven wake runtime for the MCPL transport.
 *
 * Phase 1's poller pulls `pending_pings` lines and hands them to the Hub wake
 * filter. This runtime is the same shape with the pull removed: the door pushes
 * `channels/incoming`, the messages are classified from their declared tags,
 * and the identical Hub-owned wake table decides what starts a turn. The table
 * is not re-litigated here — producer tags and producer treatment suggestions
 * are evidence, never authority.
 *
 * Turns are serialized. A knock arriving mid-turn queues behind the one in
 * flight rather than opening a second concurrent conversation with the same
 * body.
 */

import { createHash } from "node:crypto";

import type { EidoverseAddressedUtterance } from "./eidoverse-adapter.js";
import {
  classifyMcplIncomingMessage,
  incomingMessageText,
  type McplIncomingChannelMessage,
} from "./eidoverse-mcpl-wire.js";
import {
  EidoverseWakeFilter,
  type EidoverseWakeEvent,
  type EidoverseWakeFilterConfig,
} from "./eidoverse-wake-filter.js";

interface EidoverseMcplWakeTarget {
  handleEidoverseAddressedUtterance(input: EidoverseAddressedUtterance): Promise<string | null>;
}

interface EidoverseMcplWakeLogger {
  warn(message: string): void;
}

export interface EidoverseMcplWakeConfig extends EidoverseWakeFilterConfig {
  /** False suppresses replayed mentions after a reconnect. See the config loader. */
  catchupWake: boolean;
}

export interface EidoverseMcplWakeRuntimeOptions {
  logger?: EidoverseMcplWakeLogger;
}

/** The transport surface the production lifecycle drives. */
export interface EidoverseMcplLifecycleClient {
  start(): Promise<void>;
  close(): Promise<void>;
  setIncomingHandler(handler: ((messages: readonly McplIncomingChannelMessage[]) => void) | null): void;
  setWorldHandler(handler: ((world: string) => void) | null): void;
}

export interface EidoverseMcplLifecycleTarget extends EidoverseMcplWakeTarget {
  start(): Promise<void>;
  close(): Promise<void>;
  handleEidoverseWorldResync(world: string): void;
}

class EidoverseMcplWakeRuntime {
  private readonly filter: EidoverseWakeFilter;
  private queue: Promise<void> = Promise.resolve();
  private nextWakeSequence = 1;

  constructor(
    private readonly target: EidoverseMcplWakeTarget,
    private readonly config: EidoverseMcplWakeConfig,
    private readonly logger: EidoverseMcplWakeLogger,
  ) {
    this.filter = new EidoverseWakeFilter(config, {
      onWake: async (event) => this.handleWake(event),
    });
  }

  /**
   * Accept one delivered batch. Returns immediately: the door is waiting on the
   * `channels/incoming` response, which the client has already written.
   */
  deliver(messages: readonly McplIncomingChannelMessage[]): void {
    this.queue = this.queue
      .then(() => this.consume(messages))
      .catch(() => {
        this.logger.warn("Eidoverse MCPL incoming batch failed");
      });
  }

  /** Drain the in-flight queue and release the ambient debounce timer. */
  async close(): Promise<void> {
    const queued = this.queue;
    this.filter.close();
    await queued;
  }

  private async consume(messages: readonly McplIncomingChannelMessage[]): Promise<void> {
    for (const message of messages) {
      const kind = classifyMcplIncomingMessage(message, {
        catchupKeepsAddressing: this.config.catchupWake,
      });
      if (!kind) continue;
      const pingLine = incomingMessageText(message);
      if (!pingLine) continue;
      await this.filter.accept({ kind, pingLine });
    }
  }

  private async handleWake(event: EidoverseWakeEvent): Promise<void> {
    const utteranceId = deterministicUtteranceId(this.nextWakeSequence, event);
    this.nextWakeSequence += 1;
    try {
      await this.target.handleEidoverseAddressedUtterance({
        utteranceId,
        userText: event.pingLine,
      });
    } catch {
      this.logger.warn("Eidoverse MCPL wake turn failed");
    }
  }
}

export function createEidoverseMcplWakeRuntime(
  target: EidoverseMcplWakeTarget,
  config: EidoverseMcplWakeConfig,
  options: EidoverseMcplWakeRuntimeOptions = {},
): EidoverseMcplWakeRuntime {
  return new EidoverseMcplWakeRuntime(target, config, options.logger ?? console);
}

/**
 * Production start/stop for the MCPL transport, mirroring the poll transport's
 * lifecycle so the Hub entrypoint chooses between them and nothing else.
 */
export function createEidoverseMcplProductionLifecycle(
  client: EidoverseMcplLifecycleClient,
  target: EidoverseMcplLifecycleTarget,
  config: EidoverseMcplWakeConfig,
  options: EidoverseMcplWakeRuntimeOptions = {},
): { start(): Promise<void>; close(): Promise<void> } {
  const wake = createEidoverseMcplWakeRuntime(target, config, options);
  return {
    async start(): Promise<void> {
      client.setIncomingHandler((messages) => wake.deliver(messages));
      // Bound before the dial: the first connection carries a world answer too,
      // and a handler bound afterwards would miss it.
      client.setWorldHandler((world) => { target.handleEidoverseWorldResync(world); });
      await client.start();
      await target.start();
    },
    async close(): Promise<void> {
      client.setIncomingHandler(null);
      client.setWorldHandler(null);
      const wakeResult = await Promise.allSettled([wake.close()]);
      const teardownResults = await Promise.allSettled([client.close(), target.close()]);
      const errors = [...wakeResult, ...teardownResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Eidoverse MCPL lifecycle teardown failed");
      }
    },
  };
}

/**
 * Same wake identity shape the poll transport mints, with its own prefix. The
 * sequence is what keeps a visitor who says the same thing twice from being
 * deduplicated into silence; the digest keeps one delivery from being counted
 * twice if the runtime re-enters with the identical event.
 */
function deterministicUtteranceId(sequence: number, event: EidoverseWakeEvent): string {
  const digest = createHash("sha256")
    .update(event.kind, "utf8")
    .update("\0")
    .update(event.pingLine, "utf8")
    .digest("hex");
  return `eidoverse-mcpl:${sequence}:${digest}`;
}
