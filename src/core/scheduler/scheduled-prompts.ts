import { createComponentLogger } from '../../shared/logger.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { isBusyTurnError } from '../../system/lifecycle/turn-contention.js';
import type { Scheduler } from './scheduler.js';
import type {
  ScheduledPromptRecord,
  ScheduledPromptStorePort,
} from './scheduled-prompt-store-port.js';

const log = createComponentLogger('ScheduledPrompts');
const DEFAULT_REHYDRATE_LIMIT = 500;

export interface ScheduledPromptAgentLoop {
  handleMessage(message: {
    id: string;
    channelId: string;
    channelType: ScheduledPromptRecord['channelType'];
    authorId: string;
    authorName: string;
    content: string;
    timestamp: Date;
  }): Promise<{ content: string }>;
  waitForIdle?(): Promise<void>;
}

export interface ScheduledPromptRuntimeOptions {
  scheduler: Scheduler;
  agentLoop: ScheduledPromptAgentLoop;
  sender: MessageSender;
  scheduledPromptStore: Pick<ScheduledPromptStorePort, 'listPending' | 'markCompleted'>;
  heartbeatChannelId?: string;
  now?: () => number;
}

export interface RegisterScheduledPromptTaskOptions extends ScheduledPromptRuntimeOptions {
  record: ScheduledPromptRecord;
  rehydrated: boolean;
}

function parseRunAt(record: ScheduledPromptRecord): number {
  const runAt = Date.parse(record.runAt);
  if (!Number.isFinite(runAt)) {
    throw new Error(`Scheduled prompt "${record.id}" has invalid runAt "${record.runAt}"`);
  }
  return runAt;
}

function buildPromptContent(
  record: ScheduledPromptRecord,
  rehydrated: boolean,
  deliveredAtMs: number,
): string {
  const runAtMs = parseRunAt(record);
  if (!rehydrated || deliveredAtMs <= runAtMs) {
    return record.prompt;
  }
  return [
    `[Scheduled prompt delivery note: This prompt was scheduled for ${record.runAt} and delivered late after a restart at ${new Date(deliveredAtMs).toISOString()}.]`,
    '',
    record.prompt,
  ].join('\n');
}

export function registerScheduledPromptTask(options: RegisterScheduledPromptTaskOptions): void {
  const runAt = parseRunAt(options.record);
  options.scheduler.register({
    id: options.record.id,
    name: options.record.name,
    type: 'one-shot',
    intervalMs: 0,
    runAt,
    handler: async () => {
      const deliver = async (): Promise<void> => {
        const deliveredAtMs = options.now?.() ?? Date.now();
        const response = await options.agentLoop.handleMessage({
          id: `planned-${deliveredAtMs}`,
          channelId: options.record.channelId,
          channelType: options.record.channelType,
          authorId: options.record.authorId,
          authorName: options.record.authorName,
          content: buildPromptContent(options.record, options.rehydrated, deliveredAtMs),
          timestamp: new Date(deliveredAtMs),
        });

        const deliveryChannelId = options.heartbeatChannelId ?? options.record.deliveryChannelId;
        if (deliveryChannelId) {
          await options.sender.send(deliveryChannelId, response.content);
        }
      };

      try {
        await deliver();
      } catch (error) {
        if (!isBusyTurnError(error)) {
          throw error;
        }
        if (typeof options.agentLoop.waitForIdle !== 'function') {
          throw error;
        }
        await options.agentLoop.waitForIdle();
        await deliver();
      }

      const completed = await options.scheduledPromptStore.markCompleted(options.record.id, {
        completedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
      if (!completed) {
        throw new Error(`Scheduled prompt "${options.record.id}" fired but could not be marked complete`);
      }
    },
    state: 'idle',
  });
}

export async function rehydrateScheduledPromptTasks(
  options: ScheduledPromptRuntimeOptions & { limit?: number },
): Promise<number> {
  const pending = await options.scheduledPromptStore.listPending({
    limit: options.limit ?? DEFAULT_REHYDRATE_LIMIT,
  });
  const now = options.now?.() ?? Date.now();
  for (const record of pending) {
    const runAt = parseRunAt(record);
    if (options.scheduler.getTask(record.id)) {
      throw new Error(`Scheduled prompt "${record.id}" is already registered`);
    }
    if (runAt <= now) {
      log.warn('Rehydrating past-due scheduled prompt; it will fire on the next scheduler tick', {
        id: record.id,
        name: record.name,
        scheduledFor: record.runAt,
        rehydratedAt: new Date(now).toISOString(),
      });
    }
    registerScheduledPromptTask({
      scheduler: options.scheduler,
      agentLoop: options.agentLoop,
      sender: options.sender,
      scheduledPromptStore: options.scheduledPromptStore,
      record,
      rehydrated: true,
      ...(options.heartbeatChannelId ? { heartbeatChannelId: options.heartbeatChannelId } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
  return pending.length;
}
