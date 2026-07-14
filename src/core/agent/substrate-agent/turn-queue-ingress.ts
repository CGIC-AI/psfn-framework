import type {
  Agent,
  AgentEvent,
  AgentMessage,
} from '../../../boundary/pi-agent/index.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { TurnRunOwnerAttribution } from './turn-run-reservation.js';

interface TurnQueueIngressCoordinatorOptions {
  agent: Agent;
  resolveOwner: () => TurnRunOwnerAttribution | null;
  runFreshOrdinary: (message: SubstrateMessage) => Promise<void>;
}

/** Owns the boundary between attributed Substrate ingress and Pi's raw queues. */
export class TurnQueueIngressCoordinator {
  private activePiQueueOwner: TurnRunOwnerAttribution | null = null;
  private readonly pendingOrdinaryInternalFollowUps: Array<{
    message: AgentMessage;
    enqueued: boolean;
  }> = [];
  private freshOrdinaryIngressTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: TurnQueueIngressCoordinatorOptions) {}

  observeAgentEvent(event: AgentEvent): void {
    if (event.type === 'agent_start') {
      this.activePiQueueOwner = this.options.resolveOwner();
      return;
    }
    if (event.type === 'message_start') {
      const pendingIndex = this.pendingOrdinaryInternalFollowUps.findIndex(
        pending => pending.message === event.message,
      );
      if (pendingIndex >= 0) {
        this.pendingOrdinaryInternalFollowUps.splice(pendingIndex, 1);
      }
      return;
    }
    if (event.type === 'agent_end') {
      this.activePiQueueOwner = null;
    }
  }

  canQueueIntoActiveOrdinaryRun(): boolean {
    return this.activePiQueueOwner !== null
      && this.activePiQueueOwner.kind !== 'candidate-turn';
  }

  deferInternalFollowUp(message: AgentMessage): void {
    this.pendingOrdinaryInternalFollowUps.push({ message, enqueued: false });
  }

  enqueuePendingInternalFollowUpsForOrdinaryRun(): void {
    for (const pending of this.pendingOrdinaryInternalFollowUps) {
      if (pending.enqueued) continue;
      pending.enqueued = true;
      this.options.agent.followUp(pending.message);
    }
  }

  async runFreshOrdinary(message: SubstrateMessage): Promise<void> {
    const predecessor = this.freshOrdinaryIngressTail;
    let release!: () => void;
    this.freshOrdinaryIngressTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      // Coordinator-created fresh ordinary turns must flush deferred internal
      // whispers too; otherwise a fresh-turn-only sequence (idle steer/followUp)
      // never delivers a whisper that public handleMessage would have flushed.
      this.enqueuePendingInternalFollowUpsForOrdinaryRun();
      await this.options.runFreshOrdinary(message);
    } finally {
      release();
    }
  }

  assertCandidateQueueEmpty(): void {
    if (!this.options.agent.hasQueuedMessages()) return;
    throw new Error(
      'Trusted ICP candidate turn refused while ordinary Agent queue ingress remains pending',
    );
  }
}
