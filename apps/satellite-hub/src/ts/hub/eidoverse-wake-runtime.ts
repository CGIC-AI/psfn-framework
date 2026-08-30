import { createHash } from "node:crypto";

import type { EidoverseAddressedUtterance } from "./eidoverse-adapter.js";
import {
  EidoversePendingPingsPoller,
  EidoverseWakeFilter,
  type EidoversePendingPingsPollConfig,
  type EidoversePendingPingsSource,
  type EidoversePollDelay,
  type EidoverseWakeEvent,
  type EidoverseWakeFilterConfig,
} from "./eidoverse-wake-filter.js";

interface EidoverseWakeTurnTarget {
  handleEidoverseAddressedUtterance(input: EidoverseAddressedUtterance): Promise<string | null>;
}

interface EidoverseWakeRuntimeLogger {
  warn(message: string): void;
}

interface EidoverseWakeRuntimeOptions {
  logger?: EidoverseWakeRuntimeLogger;
  delay?: EidoversePollDelay;
}

interface EidoverseMcpProductionSource extends EidoversePendingPingsSource {
  start(): Promise<void>;
  close(): Promise<void>;
}

interface EidoverseWakeProductionTarget extends EidoverseWakeTurnTarget {
  start(): Promise<void>;
  close(): Promise<void>;
}

class EidoverseWakeRuntime {
  private readonly filter: EidoverseWakeFilter;
  private readonly poller: EidoversePendingPingsPoller;
  private nextWakeSequence = 1;

  constructor(
    source: EidoversePendingPingsSource,
    private readonly target: EidoverseWakeTurnTarget,
    config: EidoverseWakeFilterConfig & EidoversePendingPingsPollConfig,
    private readonly logger: EidoverseWakeRuntimeLogger,
    delay?: EidoversePollDelay,
  ) {
    this.filter = new EidoverseWakeFilter(config, {
      onWake: async (event) => this.handleWake(event),
    });
    this.poller = new EidoversePendingPingsPoller(source, this.filter, config, {
      ...(delay ? { delay } : {}),
      onError: () => this.logger.warn("Eidoverse pending_pings poll failed"),
    });
  }

  start(): void {
    this.poller.start();
  }

  close(): Promise<void> {
    return this.poller.close();
  }

  pollOnce(): Promise<void> {
    return this.poller.pollOnce();
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
      this.logger.warn("Eidoverse wake turn failed");
    }
  }
}

export function createEidoverseWakeRuntime(
  source: EidoversePendingPingsSource,
  target: EidoverseWakeTurnTarget,
  config: EidoverseWakeFilterConfig & EidoversePendingPingsPollConfig,
  options: EidoverseWakeRuntimeOptions = {},
): EidoverseWakeRuntime {
  return new EidoverseWakeRuntime(
    source,
    target,
    config,
    options.logger ?? console,
    options.delay,
  );
}

export function createEidoverseProductionWakeLifecycle(
  source: EidoverseMcpProductionSource,
  target: EidoverseWakeProductionTarget,
  config: EidoverseWakeFilterConfig & EidoversePendingPingsPollConfig,
  options: EidoverseWakeRuntimeOptions = {},
): { start(): Promise<void>; close(): Promise<void> } {
  const wake = createEidoverseWakeRuntime(source, target, config, options);
  return {
    async start(): Promise<void> {
      await source.start();
      await target.start();
      wake.start();
    },
    async close(): Promise<void> {
      const wakeResult = await Promise.allSettled([wake.close()]);
      const teardownResults = await Promise.allSettled([source.close(), target.close()]);
      const errors = [...wakeResult, ...teardownResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Eidoverse production lifecycle teardown failed");
      }
    },
  };
}

function deterministicUtteranceId(sequence: number, event: EidoverseWakeEvent): string {
  const digest = createHash("sha256")
    .update(event.kind, "utf8")
    .update("\0")
    .update(event.pingLine, "utf8")
    .digest("hex");
  return `eidoverse-pending:${sequence}:${digest}`;
}
