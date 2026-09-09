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
 * body, and that queue is bounded: Phase 1's poll loop asked for the next batch
 * only once the previous turn had finished, so its backpressure was structural,
 * while a pushed transport has none of its own. Past the configured budget the
 * arriving batch is dropped and counted rather than deepening a backlog of
 * inference the Hub can never work off. Drop accounting is content-free — batch
 * and message counts only, never a ping line or a world name.
 */

import { createHash } from "node:crypto";

import type { EidoverseAddressedUtterance } from "./eidoverse-adapter.js";
import {
  MCPL_CHAT_TAG,
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
  /** Optional: learn the world's human/ai classification of a participant. */
  observeEidoverseParticipant?(id: string, kind: "human" | "ai"): void;
}

interface EidoverseMcplWakeLogger {
  warn(message: string): void;
  info?(message: string): void;
}

/** How many characters of a waking message the info log line carries. */
const WAKE_LOG_TEXT_PREFIX = 120;
/** Producer tag on the Hub's own echoed speech (eidoverse `chat:from-agent`). */
const FROM_AGENT_TAG = "chat:from-agent";

export interface EidoverseMcplWakeConfig extends EidoverseWakeFilterConfig {
  /** False suppresses replayed mentions after a reconnect. See the config loader. */
  catchupWake: boolean;
  /**
   * Delivered batches that may wait for the dispatcher at once. The batch being
   * consumed does not occupy the budget; only batches still waiting do.
   */
  wakeQueueLimit: number;
  /**
   * Names this companion answers to in-world besides what the door tags: the
   * configured display name and any ids. The door tags `chat:mention` by
   * participant id only, so a visitor who writes the display name of a
   * companion whose id differs (`artie-kube` shown as "Artie") would otherwise
   * be ambient. Matched case-insensitively, `@` optional, punctuation after.
   */
  agentNames?: readonly string[];
}

/** Content-free wake-dispatch drop accounting: counts, never content. */
export interface EidoverseMcplWakeDropStats {
  droppedBatches: number;
  droppedMessages: number;
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
  private waitingBatches = 0;
  private droppedBatches = 0;
  private droppedMessages = 0;
  private overflowReported = false;
  private nextWakeSequence = 1;

  constructor(
    private readonly target: EidoverseMcplWakeTarget,
    private readonly config: EidoverseMcplWakeConfig,
    private readonly logger: EidoverseMcplWakeLogger,
  ) {
    if (!Number.isInteger(config.wakeQueueLimit) || config.wakeQueueLimit <= 0) {
      throw new Error("Eidoverse MCPL wake queue limit must be a positive integer");
    }
    this.filter = new EidoverseWakeFilter(config, {
      onWake: async (event) => this.handleWake(event),
    });
  }

  /**
   * Accept one delivered batch. Returns immediately: the door is waiting on the
   * `channels/incoming` response, which the client has already written.
   *
   * A batch arriving with the budget already full is tail-dropped: the oldest
   * queued knocks are the ones with a conversation still attached to them, and
   * dropping the newest keeps the queue's ordering honest.
   */
  deliver(messages: readonly McplIncomingChannelMessage[]): void {
    if (this.waitingBatches >= this.config.wakeQueueLimit) {
      this.recordDrop(messages.length);
      return;
    }
    this.waitingBatches += 1;
    this.queue = this.queue
      .then(() => {
        // The batch stops waiting the moment it starts being consumed: the
        // budget bounds the backlog, not the turn in flight.
        this.waitingBatches -= 1;
        if (this.waitingBatches === 0) this.reportDrain();
        return this.consume(messages);
      })
      .catch(() => {
        this.logger.warn("Eidoverse MCPL incoming batch failed");
      });
  }

  /** Content-free drop accounting for the bounded dispatch queue. */
  dropStats(): EidoverseMcplWakeDropStats {
    return { droppedBatches: this.droppedBatches, droppedMessages: this.droppedMessages };
  }

  /** Drain the in-flight queue and release the ambient debounce timer. */
  async close(): Promise<void> {
    const queued = this.queue;
    this.filter.close();
    await queued;
  }

  /**
   * Close one overflow episode. The opening line froze its counts at the first
   * drop — which is the least informative moment of a storm — so the episode
   * also reports its cumulative totals once the backlog has drained. Two
   * bounded lines per episode, counts only.
   */
  private reportDrain(): void {
    if (!this.overflowReported) return;
    this.overflowReported = false;
    this.logger.warn(
      "Eidoverse MCPL wake dispatch queue drained; "
      + `dropped batches ${this.droppedBatches}, dropped messages ${this.droppedMessages}`,
    );
  }

  /**
   * One line when an overflow episode opens, carrying counts only. A knock
   * storm is exactly the situation where a line per dropped batch would bury
   * the log, so the rest of the episode stays quiet until it drains.
   */
  private recordDrop(messageCount: number): void {
    this.droppedBatches += 1;
    this.droppedMessages += messageCount;
    if (this.overflowReported) return;
    this.overflowReported = true;
    this.logger.warn(
      `Eidoverse MCPL wake dispatch queue is full (limit ${this.config.wakeQueueLimit}); `
      + `dropped batches ${this.droppedBatches}, dropped messages ${this.droppedMessages}`,
    );
  }

  private async consume(messages: readonly McplIncomingChannelMessage[]): Promise<void> {
    for (const message of messages) {
      const speaker = speakerOf(message);
      if (speaker) this.target.observeEidoverseParticipant?.(speaker.id, speaker.kind);
      let kind = classifyMcplIncomingMessage(message, {
        catchupKeepsAddressing: this.config.catchupWake,
      });
      const pingLine = incomingMessageText(message);
      if (!pingLine) continue;
      let reason = kind ? `tag:${(message.tags ?? []).filter((tag) => typeof tag === "string").join(",")}` : "";
      if (kind === "say" && this.addressedByName(message, pingLine)) {
        kind = "mention";
        reason = "name-match";
      }
      if (!kind) continue;
      await this.filter.accept({
        kind,
        pingLine,
        messageId: message.messageId,
        author: message.author,
        reason,
        ...(speaker ? { speaker } : {}),
      });
    }
  }

  /**
   * Hub-side addressing for ambient chat the door did not tag as a mention.
   * Only plain `chat:ambient` chat qualifies (acts, weather and world changes
   * are not speech), the Hub's own echoed lines never do, and a message whose
   * author IS this companion is never a wake.
   */
  private addressedByName(message: McplIncomingChannelMessage, text: string): boolean {
    const names = (this.config.agentNames ?? []).map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return false;
    const tags = (message.tags ?? []).filter((tag): tag is string => typeof tag === "string");
    if (!tags.includes(MCPL_CHAT_TAG.ambient) || tags.includes(FROM_AGENT_TAG)) return false;
    // Acts, weather, presence and digests ride `chat:ambient` too; only plain
    // speech (no producer tag) can be an unrecognised address.
    if (tags.some((tag) => tag.startsWith("eidoverse:"))) return false;
    const author = message.author;
    if (isSelf(author, names)) return false;
    return mentionsAnyName(text, names);
  }

  private async handleWake(event: EidoverseWakeEvent): Promise<void> {
    const utteranceId = deterministicUtteranceId(this.nextWakeSequence, event);
    this.nextWakeSequence += 1;
    this.logger.info?.(
      `Eidoverse wake: message ${event.messageId ?? "?"} from ${event.author?.id ?? "?"} `
      + `(${event.speaker?.kind ?? "unknown"}) kind=${event.kind} reason=${event.reason ?? "tag"} `
      + `text=${JSON.stringify(event.pingLine.slice(0, WAKE_LOG_TEXT_PREFIX))}`,
    );
    try {
      await this.target.handleEidoverseAddressedUtterance({
        utteranceId,
        userText: event.pingLine,
        ...(event.speaker ? { speaker: event.speaker } : {}),
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

function isSelf(author: { id: string; name: string } | undefined, names: readonly string[]): boolean {
  if (!author) return false;
  const candidates = [author.id, author.name].filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
  return names.some((name) => candidates.includes(name.toLowerCase()));
}

/**
 * True when `text` addresses one of `names`: case-insensitive, an optional
 * leading `@`, and any punctuation after the name (`@Artie,`, `artie:`,
 * `hey Artie!`). A name embedded in a longer word (`artiest`) does not count.
 */
export function mentionsAnyName(text: string, names: readonly string[]): boolean {
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}@_-])@?${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_-])`, "iu");
    if (pattern.test(text)) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The world's own classification of a chat author. The door tags every line
 * an agent wrote `chat:from-agent`; a chat line without it came from a human.
 * World-authored events (acts, presence, weather) name no speaker.
 */
export function speakerOf(
  message: McplIncomingChannelMessage,
): { id: string; name: string; kind: "human" | "ai" } | null {
  const author = message.author;
  if (!author || typeof author.id !== "string" || !author.id || author.id === "world") return null;
  const tags = (message.tags ?? []).filter((tag): tag is string => typeof tag === "string");
  if (!tags.some((tag) => tag.startsWith("chat:"))) return null;
  if (tags.some((tag) => tag.startsWith("eidoverse:") && tag !== "eidoverse:catchup" && tag !== "eidoverse:whisper")) return null;
  return {
    id: author.id,
    name: typeof author.name === "string" && author.name ? author.name : author.id,
    kind: tags.includes(FROM_AGENT_TAG) ? "ai" : "human",
  };
}
