import type { ChannelType } from '../../shared/contracts/runtime.js';

export type ScheduledPromptSource = 'schedule_tool';
export type ScheduledPromptStatus = 'pending' | 'completed';

export interface ScheduledPromptRecord {
  id: string;
  name: string;
  prompt: string;
  runAt: string;
  createdAt: string;
  source: ScheduledPromptSource;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  status: ScheduledPromptStatus;
  deliveryChannelId?: string;
  completedAt?: string;
}

export interface ScheduledPromptCreateInput {
  id: string;
  name: string;
  prompt: string;
  runAt: string;
  createdAt?: string;
  source: ScheduledPromptSource;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  deliveryChannelId?: string;
}

export interface ScheduledPromptListOptions {
  limit?: number;
}

export interface ScheduledPromptCompletionOptions {
  completedAt?: string;
}

export interface ScheduledPromptStorePort {
  create(input: ScheduledPromptCreateInput): Promise<ScheduledPromptRecord>;
  listPending(options?: ScheduledPromptListOptions): Promise<ScheduledPromptRecord[]>;
  markCompleted(
    id: string,
    options?: ScheduledPromptCompletionOptions,
  ): Promise<ScheduledPromptRecord | null>;
}
