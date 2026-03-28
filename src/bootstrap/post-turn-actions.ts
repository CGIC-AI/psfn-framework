import { existsSync, readFileSync } from 'node:fs';
import type { InferredPostTurnAction } from '../shared/contracts/runtime.js';
import type { EventBus } from '../shared/event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../shared/logger.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';
import { isRecord } from '../shared/utils/types.js';
import type {
  EligibilityDecision,
  EligibilityGate,
} from '../system/capabilities/eligibility.js';

const log = createComponentLogger('PostTurnActions');

export interface PostTurnActionAgent {
  waitForIdle?(): Promise<void>;
}

export type PostTurnActionHandler = (action: InferredPostTurnAction) => Promise<void> | void;
export type PostTurnActionExecutionMode = 'foreground' | 'background';

export interface PostTurnActionHandlerOptions {
  executionMode?: PostTurnActionExecutionMode;
}

export interface PostTurnActionRuntime {
  registerHandler(
    kind: string,
    handler: PostTurnActionHandler,
    options?: PostTurnActionHandlerOptions,
  ): () => void;
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

interface RegisteredPostTurnActionHandler {
  callback: PostTurnActionHandler;
  executionMode: PostTurnActionExecutionMode;
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
  persistencePath?: string;
}

const DEFAULT_TASK_ID = 'post-turn-action-executor';
const PERSISTED_QUEUE_VERSION = 1;

interface PersistedQueueFile {
  version: number;
  entries: unknown[];
}

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
    persistencePath,
  } = options;

  const handlers = new Map<string, Map<PostTurnActionHandler, RegisteredPostTurnActionHandler>>();
  const queue = new Map<string, DeferredQueueEntry>();
  let processing = false;

  const normalizePositiveInteger = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return Math.floor(value);
  };

  const normalizeActionRunAt = (value: unknown): number | undefined => {
    const normalized = normalizePositiveInteger(value);
    if (normalized === undefined || normalized <= 0) {
      return undefined;
    }
    return normalized;
  };

  const normalizeMaxRetries = (value: number | undefined): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return Math.max(0, Math.floor(defaultMaxRetries));
    }
    return Math.max(0, Math.floor(value));
  };

  const resolveInitialNextRunAt = (action: InferredPostTurnAction): number => {
    const now = Date.now();
    const runAt = normalizeActionRunAt(action.runAt);
    if (runAt === undefined) {
      return now;
    }
    return Math.max(now, runAt);
  };

  const normalizePersistedAction = (value: unknown): InferredPostTurnAction | null => {
    if (!isRecord(value)) {
      return null;
    }

    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
    const dedupeKey = typeof value.dedupeKey === 'string' ? value.dedupeKey.trim() : '';
    const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
    const sourceMessageId = typeof value.sourceMessageId === 'string' ? value.sourceMessageId.trim() : '';
    const inferredAt = normalizePositiveInteger(value.inferredAt);
    if (!id || !kind || !dedupeKey || !channelId || !sourceMessageId || inferredAt === undefined) {
      return null;
    }

    const payload = isRecord(value.payload) ? value.payload : {};
    const maxRetries = normalizePositiveInteger(value.maxRetries);
    const runAt = normalizeActionRunAt(value.runAt);

    return {
      id,
      kind,
      payload,
      dedupeKey,
      channelId,
      sourceMessageId,
      inferredAt,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    };
  };

  const normalizePersistedQueueEntry = (value: unknown): DeferredQueueEntry | null => {
    if (!isRecord(value)) {
      return null;
    }
    const action = normalizePersistedAction(value.action);
    if (!action) {
      return null;
    }

    const attempt = normalizePositiveInteger(value.attempt);
    const nextRunAt = normalizeActionRunAt(value.nextRunAt);
    const maxRetries = normalizePositiveInteger(value.maxRetries);
    if (attempt === undefined || nextRunAt === undefined) {
      return null;
    }

    const resolvedMaxRetries = maxRetries !== undefined
      ? maxRetries
      : normalizeMaxRetries(action.maxRetries);
    if (attempt > resolvedMaxRetries + 1) {
      return null;
    }

    return {
      action,
      attempt,
      nextRunAt,
      maxRetries: resolvedMaxRetries,
    };
  };

  const persistQueue = (): void => {
    if (!persistencePath) {
      return;
    }

    const serialized = {
      version: PERSISTED_QUEUE_VERSION,
      entries: [...queue.values()].map((entry) => ({
        action: entry.action,
        attempt: entry.attempt,
        nextRunAt: entry.nextRunAt,
        maxRetries: entry.maxRetries,
      })),
    } satisfies PersistedQueueFile;

    try {
      writeJsonAtomic(persistencePath, serialized);
    } catch (error) {
      log.error('Failed to persist deferred post-turn action queue', {
        persistencePath,
        error: String(error),
      });
    }
  };

  const hydrateQueue = (): void => {
    if (!persistencePath || !existsSync(persistencePath)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(persistencePath, 'utf-8'));
    } catch (error) {
      log.error('Failed to load deferred post-turn action queue; starting empty', {
        persistencePath,
        error: String(error),
      });
      return;
    }

    if (!isRecord(parsed) || parsed.version !== PERSISTED_QUEUE_VERSION || !Array.isArray(parsed.entries)) {
      log.error('Deferred post-turn action queue payload is invalid; starting empty', {
        persistencePath,
      });
      return;
    }

    let loaded = 0;
    let dropped = 0;
    for (const rawEntry of parsed.entries) {
      const entry = normalizePersistedQueueEntry(rawEntry);
      if (!entry) {
        dropped += 1;
        continue;
      }
      if (queue.has(entry.action.dedupeKey)) {
        dropped += 1;
        continue;
      }
      queue.set(entry.action.dedupeKey, entry);
      loaded += 1;
    }

    if (loaded > 0) {
      log.info('Loaded deferred post-turn action queue from disk', {
        persistencePath,
        loaded,
      });
    }
    if (dropped > 0) {
      log.warn('Dropped invalid deferred post-turn action queue entries during load', {
        persistencePath,
        dropped,
      });
      persistQueue();
    }
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
      nextRunAt: resolveInitialNextRunAt(action),
      maxRetries: normalizeMaxRetries(action.maxRetries),
    };
    queue.set(action.dedupeKey, entry);
    persistQueue();
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

    const registrations = handlers.get(entry.action.kind);
    if (!registrations || registrations.size === 0) {
      queue.delete(entry.action.dedupeKey);
      persistQueue();
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
        persistQueue();
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
    persistQueue();
    emitTelemetry('started', entry);

    try {
      const registeredHandlers = [...registrations.values()];
      const requiresForegroundIdle = registeredHandlers.some(
        ({ executionMode }) => executionMode !== 'background',
      );
      if (requiresForegroundIdle) {
        await agentLoop.waitForIdle?.();
      }
      for (const { callback } of registeredHandlers) {
        await callback(entry.action);
      }
      queue.delete(entry.action.dedupeKey);
      persistQueue();
      emitTelemetry('succeeded', entry);
    } catch (error) {
      const errorText = String(error);
      if (entry.attempt > entry.maxRetries) {
        queue.delete(entry.action.dedupeKey);
        persistQueue();
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
      persistQueue();
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

  hydrateQueue();

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
    registerHandler(
      kind: string,
      handler: PostTurnActionHandler,
      options: PostTurnActionHandlerOptions = {},
    ): () => void {
      const normalizedKind = kind.trim();
      if (!normalizedKind) {
        throw new Error('Deferred action handler kind must be non-empty');
      }
      const handlerSet = handlers.get(normalizedKind) ?? new Map<PostTurnActionHandler, RegisteredPostTurnActionHandler>();
      handlerSet.set(handler, {
        callback: handler,
        executionMode: options.executionMode === 'background' ? 'background' : 'foreground',
      });
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
