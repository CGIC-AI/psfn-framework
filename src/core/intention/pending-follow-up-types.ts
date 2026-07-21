import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { ActiveConcernVAD } from '../../shared/contracts/intention-contracts.js';
import type {
  PendingFollowUp,
  PendingFollowUpPriority,
  PendingFollowUpTiming,
  PendingFollowUpWakeCondition,
} from '../../shared/contracts/intention-contracts.js';

export type {
  PendingFollowUp,
  PendingFollowUpPriority,
  PendingFollowUpTiming,
  PendingFollowUpWakeCondition,
} from '../../shared/contracts/intention-contracts.js';

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
  /** Live internal VAD at follow-up formation (bead vw3w.3). */
  formationVAD?: ActiveConcernVAD;
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
  /** Live internal VAD at follow-up completion/activation (bead vw3w.3). */
  completionVAD?: ActiveConcernVAD;
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
