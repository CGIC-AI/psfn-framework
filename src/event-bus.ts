import type { SubstrateMessage, AgentResponse, TurnUsage } from './types.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('EventBus');

// ── Event map: all typed events in the system ──

export interface ExternalTelemetryEvent {
  id: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
  nonce: string;
  channelId?: string;
  scope?: string;
}

export interface EventMap {
  'message.received': { message: SubstrateMessage };
  'message.sent': { response: AgentResponse };
  'agent.turn.start': { message: SubstrateMessage };
  'agent.turn.end': { message: SubstrateMessage; response: AgentResponse };
  'agent.turn.stage': {
    turnId: string;
    channelId: string;
    stage: string;
    elapsedMs: number;
    [key: string]: unknown;
  };
  'agent.turn.usage': { message: SubstrateMessage; usage: TurnUsage };
  'agent.stream.delta': { channelId: string; text: string };
  'agent.stream.thinking': { channelId: string; text: string };
  'agent.tool.start': { channelId: string; toolCallId: string; toolName: string };
  'agent.tool.end': { channelId: string; toolCallId: string; toolName: string; isError: boolean };
  'agent.compaction.start': {
    channelId: string;
    reason: 'threshold' | 'overflow';
    tokensBefore: number;
    tokenBudget: number;
  };
  'agent.compaction.end': { channelId: string; tokensBefore: number; tokensAfter: number };
  'agent.retry.start': {
    channelId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  };
  'agent.retry.end': { channelId: string; success: boolean; attempt: number };
  'agent.think.trace': {
    timestamp: number;
    task: string;
    result: {
      iterations: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      durationMs: number;
      truncated: boolean;
      budgetStop: string | null;
      steps: Array<{
        iteration: number;
        timestamp: number;
        code: string;
        output: string;
        error: string | null;
        inputTokens: number;
        outputTokens: number;
        cumulativeTokens: number;
        durationMs: number;
        variablesChanged: string[];
      }>;
    };
  };
  'agent.error': { message: SubstrateMessage; error: Error };
  'memory.extraction.start': { channelId: string; triggerReason?: string };
  'memory.extraction.end': {
    channelId: string;
    count: number;
    triggerReason?: string;
    coveredUpToMessageId?: number;
    parsedCount?: number;
    acceptedCount?: number;
    rejectedCount?: number;
    writeCount?: number;
    deduplicatedCount?: number;
    supersededCount?: number;
    rejectionBreakdown?: Record<string, number>;
  };
  'memory.retrieval': {
    channelId: string;
    count: number;
    candidates?: number;
    ranked?: number;
    returned?: number;
    reason?: string;
  };
  'channel.queue.telemetry': {
    channelId: string;
    phase: 'acquired' | 'contended' | 'released';
    queueDepth: number;
    waitMs: number;
    processingChannels: number;
    timestamp: number;
  };
  'session.created': { channelId: string };
  'session.compacted': { channelId: string; before: number; after: number };
  'schedule.tick': { timestamp: number };
  'schedule.task.run': { taskId: string; taskName: string; type: string };
  'schedule.heartbeat': { timestamp: number; taskCount: number };
  'channel.voice.start': { guildId: string; channelId: string; userId: string };
  'channel.voice.end': { guildId: string; channelId: string; userId: string; reason: string };
  'channel.voice.transcript.partial': {
    guildId: string;
    channelId: string;
    userId: string;
    transcript: string;
    confidence?: number;
    startMs?: number;
    endMs?: number;
  };
  'channel.voice.transcript': { guildId: string; channelId: string; userId: string; transcript: string };
  'channel.voice.tts.sent': { guildId: string; channelId: string; userId: string; text: string };
  'channel.voice.error': {
    guildId?: string;
    channelId?: string;
    userId?: string;
    error: string;
  };
  'voice.turn.start': {
    turnId: string;
    channelId?: string;
    userId?: string;
    timestampMs?: number;
  };
  'voice.turn.end': {
    turnId: string;
    channelId?: string;
    userId?: string;
    status?: 'completed' | 'cancelled' | 'timeout' | 'error';
    reason?: string;
    timestampMs?: number;
  };
  'voice.turn.interrupted': {
    turnId: string;
    channelId?: string;
    userId?: string;
    reason?: string;
    timestampMs?: number;
  };
  'voice.frame.dropped': {
    turnId?: string;
    channelId?: string;
    userId?: string;
    stage?: 'transport' | 'stt' | 'tts' | 'pipeline' | 'unknown';
    reason?: string;
    count?: number;
    timestampMs?: number;
  };
  'voice.turn.error': {
    turnId?: string;
    channelId?: string;
    userId?: string;
    stage?: 'transport' | 'stt' | 'tts' | 'orchestrator' | 'unknown';
    code?: string;
    error: string;
    timestampMs?: number;
  };
  'voice.stt.partial': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text?: string;
    timestampMs?: number;
  };
  'voice.stt.final': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text: string;
    timestampMs?: number;
  };
  'voice.tts.requested': {
    turnId: string;
    channelId?: string;
    userId?: string;
    text?: string;
    timestampMs?: number;
  };
  'voice.tts.first-byte': {
    turnId: string;
    channelId?: string;
    userId?: string;
    timestampMs?: number;
  };
  'external.telemetry.ingested': { event: ExternalTelemetryEvent };
  'system.init': Record<string, never>;
  'system.ready': Record<string, never>;
  'system.shutdown': Record<string, never>;
  'system.error': { error: Error; context?: string };
}

export type EventName = keyof EventMap;
type Handler<T> = (data: T) => void | Promise<void>;
type Guard<T> = (data: T) => boolean | Promise<boolean>;

interface HandlerEntry<T = unknown> {
  handler: Handler<T>;
  once: boolean;
}

export class EventBus {
  private handlers = new Map<EventName, HandlerEntry[]>();
  private guards = new Map<EventName, Guard<unknown>[]>();

  on<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
    return this.addHandler(event, handler, false);
  }

  once<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
    return this.addHandler(event, handler, true);
  }

  off<E extends EventName>(event: E, handler: Handler<EventMap[E]>): void {
    const entries = this.handlers.get(event);
    if (!entries) return;
    const idx = entries.findIndex(e => e.handler === handler);
    if (idx !== -1) entries.splice(idx, 1);
  }

  guard<E extends EventName>(event: E, guard: Guard<EventMap[E]>): () => void {
    const guards = this.guards.get(event) ?? [];
    guards.push(guard as Guard<unknown>);
    this.guards.set(event, guards);
    return () => {
      const idx = guards.indexOf(guard as Guard<unknown>);
      if (idx !== -1) guards.splice(idx, 1);
    };
  }

  async emit<E extends EventName>(event: E, data: EventMap[E]): Promise<void> {
    // Run guards — if any return false, cancel the event
    const guards = this.guards.get(event);
    if (guards) {
      for (const guard of guards) {
        const allowed = await guard(data);
        if (!allowed) return;
      }
    }

    const entries = this.handlers.get(event);
    if (!entries || entries.length === 0) return;

    // Snapshot to handle mutations during iteration
    const snapshot = [...entries];
    const toRemove: HandlerEntry[] = [];

    const results = await Promise.allSettled(
      snapshot.map(async (entry) => {
        if (entry.once) toRemove.push(entry);
        await entry.handler(data);
      }),
    );

    // Remove once-handlers
    for (const entry of toRemove) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
    }

    // Log errors but don't throw — one handler failure shouldn't kill others
    for (const result of results) {
      if (result.status === 'rejected') {
        log.error(`Handler error on "${event}": ${result.reason}`);
      }
    }
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.handlers.delete(event);
      this.guards.delete(event);
    } else {
      this.handlers.clear();
      this.guards.clear();
    }
  }

  private addHandler<E extends EventName>(
    event: E,
    handler: Handler<EventMap[E]>,
    once: boolean,
  ): () => void {
    const entries = this.handlers.get(event) ?? [];
    const entry: HandlerEntry = { handler: handler as Handler<unknown>, once };
    entries.push(entry);
    this.handlers.set(event, entries);
    return () => this.off(event, handler);
  }
}
