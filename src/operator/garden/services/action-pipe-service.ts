import type { PostTurnActionRuntime } from '../../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import type {
  AdminActionPipeMutationResult,
  AdminActionPipeService,
  AdminActionPipeStatus,
} from './types.js';

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
    return {
      ...status,
      outreachOutbox: {
        recentRecords: this.outreachOutbox.listRecent(25),
      },
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
