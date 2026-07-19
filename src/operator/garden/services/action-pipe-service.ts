import type { PostTurnActionRuntime } from '../../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import type {
  AdminActionPipeMutationResult,
  AdminActionPipeService,
  AdminActionPipeStatus,
} from './types.js';
import type { OutreachOutboxRecord } from '../../../core/intention/outreach-outbox.js';
import type { AdminTaskLifecycleNotification } from './types/action-pipe.js';
import {
  isCompletionHandoffSource,
  isCompletionHandoffStatus,
} from '../../../shared/contracts/completion-handoff.js';

function projectTaskLifecycleNotifications(
  records: readonly OutreachOutboxRecord[],
): AdminTaskLifecycleNotification[] {
  const projected: AdminTaskLifecycleNotification[] = [];
  const seenDedupeKeys = new Set<string>();
  for (const record of records) {
    const metadata = record.metadata;
    if (
      metadata?.kind !== 'task_lifecycle_notification'
      || seenDedupeKeys.has(record.dedupeKey)
      || typeof metadata.handoffId !== 'string'
      || !isCompletionHandoffSource(metadata.source)
      || !isCompletionHandoffStatus(metadata.lifecycleStatus)
      || typeof metadata.taskLabel !== 'string'
      || typeof metadata.notificationDisposition !== 'string'
      || !['queued', 'sent', 'skipped', 'denied', 'failed']
        .includes(metadata.notificationDisposition)
    ) {
      continue;
    }
    seenDedupeKeys.add(record.dedupeKey);
    projected.push({
      actionId: record.actionId,
      handoffId: metadata.handoffId,
      source: metadata.source,
      lifecycleStatus: metadata.lifecycleStatus,
      taskLabel: metadata.taskLabel,
      notificationStatus:
        metadata.notificationDisposition as AdminTaskLifecycleNotification['notificationStatus'],
      recordedAt: record.recordedAt,
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.error && !record.reason ? { reason: record.error } : {}),
    });
  }
  return projected;
}

export class AdminActionPipeDataService implements AdminActionPipeService {
  constructor(
    private readonly runtime: PostTurnActionRuntime,
    private readonly outreachOutbox?: OutreachOutboxStore | null,
  ) {}

  async getActionPipeStatus(): Promise<AdminActionPipeStatus> {
    const status = this.runtime.getStatus();
    if (!this.outreachOutbox) {
      return status;
    }
    const recentRecords = this.outreachOutbox.listRecent(25);
    return {
      ...status,
      outreachOutbox: {
        recentRecords,
      },
      taskLifecycleNotifications: projectTaskLifecycleNotifications(recentRecords),
    };
  }

  async cancelAction(input: { actionRef: string; reason?: string }): Promise<AdminActionPipeMutationResult> {
    const actionRef = input.actionRef.trim();
    const statusBefore = this.runtime.getActionStatus(actionRef);
    if (!actionRef) {
      return {
        ok: false,
        message: 'Action reference is required.',
        status: this.runtime.getStatus(),
      };
    }
    if (!statusBefore) {
      return {
        ok: false,
        message: 'Action was not found in the queue or recent action history.',
        status: this.runtime.getStatus(),
      };
    }
    if (!statusBefore.cancellable) {
      return {
        ok: false,
        message: `Action is ${statusBefore.state} and cannot be cancelled.`,
        action: statusBefore,
        status: this.runtime.getStatus(),
      };
    }

    const ok = this.runtime.cancel(actionRef, input.reason);
    const action = this.runtime.getActionStatus(actionRef);
    return {
      ok,
      message: ok ? 'Action cancelled.' : 'Action could not be cancelled.',
      ...(action ? { action } : {}),
      status: this.runtime.getStatus(),
    };
  }

  async acknowledgeAction(input: { actionRef: string; detail?: string }): Promise<AdminActionPipeMutationResult> {
    const actionRef = input.actionRef.trim();
    const statusBefore = this.runtime.getActionStatus(actionRef);
    if (!actionRef) {
      return {
        ok: false,
        message: 'Action reference is required.',
        status: this.runtime.getStatus(),
      };
    }
    if (!statusBefore) {
      return {
        ok: false,
        message: 'Action was not found in the queue or recent action history.',
        status: this.runtime.getStatus(),
      };
    }
    if (!statusBefore.cancellable) {
      return {
        ok: false,
        message: `Action is ${statusBefore.state} and cannot be acknowledged.`,
        action: statusBefore,
        status: this.runtime.getStatus(),
      };
    }

    const ok = this.runtime.acknowledge(actionRef, input.detail);
    const action = this.runtime.getActionStatus(actionRef);
    return {
      ok,
      message: ok ? 'Action acknowledged.' : 'Action could not be acknowledged.',
      ...(action ? { action } : {}),
      status: this.runtime.getStatus(),
    };
  }
}
