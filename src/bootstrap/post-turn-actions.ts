import type { InferredPostTurnAction } from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import type {
  EligibilityDecision,
  EligibilityGate,
} from '../capabilities/eligibility.js';

const log = createComponentLogger('PostTurnActions');

export interface PostTurnActionAgent {
  waitForIdle?(): Promise<void>;
}

export type PostTurnActionHandler = (action: InferredPostTurnAction) => Promise<void> | void;

export interface PostTurnActionRuntime {
  registerHandler(kind: string, handler: PostTurnActionHandler): () => void;
  listQueued(): Array<{
    actionId: string;
    actionKind: string;
    dedupeKey: string;
    attempt: number;
    maxAttempts: number;
    nextRunAt: number;
  }>;
}

interface DeferredQueueEntry {
  action: InferredPostTurnAction;
  attempt: number;
  nextRunAt: number;
  maxRetries: number;
}

export interface WirePostTurnActionRuntimeOptions {
  eventBus: EventBus;
  scheduler: Scheduler;
  agentLoop: PostTurnActionAgent;
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  taskId?: string;
  intervalMs?: number;
  defaultMaxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const DEFAULT_TASK_ID = 'post-turn-action-executor';

export function wirePostTurnActionRuntime(
  options: WirePostTurnActionRuntimeOptions,
): PostTurnActionRuntime {
  const {
    eventBus,
    scheduler,
    agentLoop,
    eligibilityGate,
    onEligibilityDecision,
    taskId = DEFAULT_TASK_ID,
    intervalMs = 250,
    defaultMaxRetries = 2,
    baseRetryDelayMs = 750,
    maxRetryDelayMs = 30_000,
  } = options;

  const handlers = new Map<string, Set<PostTurnActionHandler>>();
  const queue = new Map<string, DeferredQueueEntry>();
  let processing = false;

  const normalizeMaxRetries = (value: number | undefined): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return Math.max(0, Math.floor(defaultMaxRetries));
    }
    return Math.max(0, Math.floor(value));
  };

  const emitTelemetry = (
    phase: 'queued' | 'deduplicated' | 'started' | 'succeeded' | 'retry_scheduled' | 'failed',
    entry: DeferredQueueEntry,
    optionsOverride: { nextRetryAt?: number; delayMs?: number; error?: string } = {},
  ): void => {
    const maxAttempts = entry.maxRetries + 1;
    eventBus.emit('agent.post_turn.action.telemetry', {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      channelId: entry.action.channelId,
      sourceMessageId: entry.action.sourceMessageId,
      dedupeKey: entry.action.dedupeKey,
      phase,
      attempt: entry.attempt,
      maxAttempts,
      queueDepth: queue.size,
      timestamp: Date.now(),
      ...(optionsOverride.nextRetryAt !== undefined ? { nextRetryAt: optionsOverride.nextRetryAt } : {}),
      ...(optionsOverride.delayMs !== undefined ? { delayMs: optionsOverride.delayMs } : {}),
      ...(optionsOverride.error !== undefined ? { error: optionsOverride.error } : {}),
    }).catch((error) => {
      log.warn('Deferred action telemetry emit failed', {
        actionId: entry.action.id,
        phase,
        error: String(error),
      });
    });
  };

  const queueAction = (action: InferredPostTurnAction): void => {
    const existing = queue.get(action.dedupeKey);
    if (existing) {
      emitTelemetry('deduplicated', existing);
      return;
    }

    const entry: DeferredQueueEntry = {
      action,
      attempt: 0,
      nextRunAt: Date.now(),
      maxRetries: normalizeMaxRetries(action.maxRetries),
    };
    queue.set(action.dedupeKey, entry);
    emitTelemetry('queued', entry);
  };

  const runNextDueAction = async (): Promise<boolean> => {
    if (queue.size === 0) {
      return false;
    }

    const now = Date.now();
    const dueEntries = [...queue.values()]
      .filter((entry) => entry.nextRunAt <= now)
      .sort((left, right) => left.nextRunAt - right.nextRunAt || left.action.inferredAt - right.action.inferredAt);
    const entry = dueEntries[0] as typeof dueEntries[number] | undefined;
    if (!entry) {
      return false;
    }

    const callbacks = handlers.get(entry.action.kind);
    if (!callbacks || callbacks.size === 0) {
      queue.delete(entry.action.dedupeKey);
      const missingHandlerError = `No deferred-action handler registered for "${entry.action.kind}"`;
      log.warn(missingHandlerError, {
        actionId: entry.action.id,
        channelId: entry.action.channelId,
      });
      emitTelemetry('failed', entry, { error: missingHandlerError });
      return true;
    }

    if (eligibilityGate) {
      const decision = eligibilityGate.evaluate(
        {
          kind: 'post_turn.action',
          actionKind: entry.action.kind,
          actionId: entry.action.id,
        },
        { requiredTokens: ['memory.write'] },
      );
      onEligibilityDecision?.(decision);
      if (!decision.allowed) {
        queue.delete(entry.action.dedupeKey);
        const denialError = `Eligibility denied (${decision.reasonCode})`;
        log.warn('Deferred action blocked by eligibility gate', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          reasonCode: decision.reasonCode,
          tier: decision.tier,
          requiredTokens: decision.requiredTokens,
          missingTokens: decision.missingTokens,
        });
        emitTelemetry('failed', entry, { error: denialError });
        return true;
      }
    }

    entry.attempt += 1;
    emitTelemetry('started', entry);

    try {
      await agentLoop.waitForIdle?.();
      for (const callback of callbacks) {
        await callback(entry.action);
      }
      queue.delete(entry.action.dedupeKey);
      emitTelemetry('succeeded', entry);
    } catch (error) {
      const errorText = String(error);
      if (entry.attempt > entry.maxRetries) {
        queue.delete(entry.action.dedupeKey);
        log.error('Deferred action exhausted retries', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          attempt: entry.attempt,
          maxRetries: entry.maxRetries,
          error: errorText,
        });
        emitTelemetry('failed', entry, { error: errorText });
        return true;
      }

      const delayMs = Math.min(maxRetryDelayMs, baseRetryDelayMs * Math.pow(2, Math.max(0, entry.attempt - 1)));
      entry.nextRunAt = Date.now() + delayMs;
      log.warn('Deferred action retry scheduled', {
        actionId: entry.action.id,
        actionKind: entry.action.kind,
        attempt: entry.attempt,
        nextRunAt: entry.nextRunAt,
        delayMs,
        error: errorText,
      });
      emitTelemetry('retry_scheduled', entry, {
        error: errorText,
        delayMs,
        nextRetryAt: entry.nextRunAt,
      });
    }

    return true;
  };

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      while (await runNextDueAction()) {
        // Continue draining due actions in a single scheduler tick.
      }
    } finally {
      processing = false;
    }
  };

  eventBus.on('agent.post_turn.actions.inferred', ({ actions }) => {
    for (const action of actions) {
      queueAction(action);
    }
  });

  if (!scheduler.getTask(taskId)) {
    scheduler.register({
      id: taskId,
      name: 'Post-Turn Action Executor',
      type: 'every',
      intervalMs: Math.max(50, intervalMs),
      handler: async () => {
        await processQueue();
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  }

  return {
    registerHandler(kind: string, handler: PostTurnActionHandler): () => void {
      const normalizedKind = kind.trim();
      if (!normalizedKind) {
        throw new Error('Deferred action handler kind must be non-empty');
      }
      const handlerSet = handlers.get(normalizedKind) ?? new Set<PostTurnActionHandler>();
      handlerSet.add(handler);
      handlers.set(normalizedKind, handlerSet);
      return () => {
        const current = handlers.get(normalizedKind);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(normalizedKind);
        }
      };
    },
    listQueued() {
      return [...queue.values()].map(entry => ({
        actionId: entry.action.id,
        actionKind: entry.action.kind,
        dedupeKey: entry.action.dedupeKey,
        attempt: entry.attempt,
        maxAttempts: entry.maxRetries + 1,
        nextRunAt: entry.nextRunAt,
      }));
    },
  };
}
