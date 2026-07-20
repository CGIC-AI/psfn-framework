import type {
  PostTurnActionQueueStatus,
  PostTurnActionStatusRecord,
} from '../../../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxRecord } from '../../../../core/intention/outreach-outbox.js';
import type {
  CompletionHandoffSource,
  CompletionHandoffStatus,
} from '../../../../shared/contracts/completion-handoff.js';

export interface AdminTaskLifecycleNotification {
  actionId: string;
  handoffId: string;
  source: CompletionHandoffSource;
  lifecycleStatus: CompletionHandoffStatus;
  taskLabel: string;
  notificationStatus: 'queued' | 'sent' | 'skipped' | 'denied' | 'failed';
  recordedAt: number;
  reason?: string;
}

export interface AdminActionPipeStatus extends PostTurnActionQueueStatus {
  outreachOutbox?: {
    recentRecords: OutreachOutboxRecord[];
  };
  taskLifecycleNotifications?: AdminTaskLifecycleNotification[];
}

export interface AdminActionPipeMutationResult {
  ok: boolean;
  message: string;
  action?: PostTurnActionStatusRecord;
  status: AdminActionPipeStatus;
}

export interface AdminActionPipeService {
  getActionPipeStatus(): Promise<AdminActionPipeStatus>;
  cancelAction(input: { actionRef: string; reason?: string }): Promise<AdminActionPipeMutationResult>;
  acknowledgeAction(input: { actionRef: string; detail?: string }): Promise<AdminActionPipeMutationResult>;
}
