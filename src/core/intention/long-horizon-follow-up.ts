import { createHash } from 'node:crypto';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type {
  ScheduledPromptRecord,
  ScheduledPromptStorePort,
} from '../scheduler/scheduled-prompt-store-port.js';
import {
  registerScheduledPromptTask,
  type ScheduledPromptAgentLoop,
} from '../scheduler/scheduled-prompts.js';
import type { LongHorizonFollowUpInput } from './runtime-wiring.js';

export interface LongHorizonFollowUpRouterOptions {
  store: ScheduledPromptStorePort;
  scheduler: Scheduler;
  agentLoop: ScheduledPromptAgentLoop;
  sender: MessageSender;
  now?: () => number;
}

function scheduledPromptId(input: LongHorizonFollowUpInput): string {
  const digest = createHash('sha256')
    .update(input.sourceMessageId)
    .update('\0')
    .update(input.dueAt)
    .update('\0')
    .update(input.channelId)
    .update('\0')
    .update(input.content)
    .digest('hex');
  return `intention-scheduled:${digest}`;
}

function matchesExpected(
  record: ScheduledPromptRecord,
  expected: Pick<
    ScheduledPromptRecord,
    'id' | 'name' | 'prompt' | 'runAt' | 'source' | 'channelId' | 'channelType' | 'authorId' | 'authorName'
  >,
): boolean {
  return record.id === expected.id
    && record.name === expected.name
    && record.prompt === expected.prompt
    && record.runAt === expected.runAt
    && record.source === expected.source
    && record.channelId === expected.channelId
    && record.channelType === expected.channelType
    && record.authorId === expected.authorId
    && record.authorName === expected.authorName;
}

export function createLongHorizonFollowUpRouter(
  options: LongHorizonFollowUpRouterOptions,
): (input: LongHorizonFollowUpInput) => Promise<string> {
  return async input => {
    const id = scheduledPromptId(input);
    const expected = {
      id,
      name: 'Scheduled intention follow-up',
      prompt: input.content,
      runAt: input.dueAt,
      source: 'intention_appraisal' as const,
      channelId: input.channelId,
      channelType: input.channelType,
      authorId: input.authorId,
      authorName: input.authorName,
    };

    let record: ScheduledPromptRecord;
    try {
      record = await options.store.create({
        ...expected,
        createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
    } catch (error) {
      const existing = await options.store.getById(id);
      if (!existing) {
        throw error;
      }
      if (!matchesExpected(existing, expected)) {
        throw new Error(`Long-horizon follow-up ${id} conflicts with the durable scheduled prompt`);
      }
      record = existing;
    }

    if (record.status === 'pending' && !options.scheduler.getTask(record.id)) {
      registerScheduledPromptTask({
        scheduler: options.scheduler,
        agentLoop: options.agentLoop,
        sender: options.sender,
        scheduledPromptStore: options.store,
        record,
        rehydrated: false,
        ...(options.now ? { now: options.now } : {}),
      });
    }
    return record.id;
  };
}
