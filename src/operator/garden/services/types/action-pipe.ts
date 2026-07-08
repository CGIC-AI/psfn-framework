import type {
  PostTurnActionQueueStatus,
  PostTurnActionStatusRecord,
} from '../../../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxRecord } from '../../../../core/intention/outreach-outbox.js';

export interface AdminActionPipeStatus extends PostTurnActionQueueStatus {
  outreachOutbox?: {
    recentRecords: OutreachOutboxRecord[];
  };
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
