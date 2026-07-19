import type { ChannelType } from '../../shared/contracts/runtime.js';

export type PendingFollowUpPriority = 'low' | 'medium' | 'high';
export type PendingFollowUpTiming = 'immediate' | 'soon' | 'scheduled';
export type PendingFollowUpWakeCondition =
  | 'next_user_turn'
  | 'background_recheck'
  | 'sustained_negative_mood';

export interface PendingFollowUp {
  id: string;
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  createdAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: PendingFollowUpWakeCondition[];
  activatedAt?: string;
  activationReason?: string;
  dampenedAt?: string;
  dampeningReason?: string;
  /** Originating ICP root preserved across durable resurface/restart. */
  originIcpRootInitiationId?: string;
}

export interface PendingFollowUpCreateInput {
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  createdAt?: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: readonly PendingFollowUpWakeCondition[];
  originIcpRootInitiationId?: string;
}

export interface PendingFollowUpUpdateInput {
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: readonly PendingFollowUpWakeCondition[];
  originIcpRootInitiationId?: string;
}

export interface PendingFollowUpActivateOptions {
  activatedAt?: string;
  activationReason?: string;
}

export interface PendingFollowUpDampenOptions {
  dampenedAt?: string;
  dampeningReason: string;
}

export interface PendingFollowUpListOptions {
  contactId?: string;
  includeActivated?: boolean;
  includeExpired?: boolean;
  asOf?: string;
  limit?: number;
}

export interface PendingFollowUpStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  backlogCap?: number;
}

export interface PendingFollowUpContextProvider {
  getPendingFollowUps(contactId?: string): PendingFollowUp[];
}
