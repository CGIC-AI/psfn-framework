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

/**
 * A claimed position in the fresh-ordinary FIFO chain. The slot is reserved
 * synchronously at ingress arrival, before author resolution, so ordering
 * follows arrival order rather than the race between concurrent author lookups.
 * The caller MUST settle the slot exactly once: `run` executes the fresh turn
 * in this position (and settles), while `dispose` releases the position when
 * the input joined an active run or was deferred instead.
 */
export interface FreshOrdinaryTurnSlot {
  run(message: SubstrateMessage): Promise<void>;
  dispose(): void;
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

  /**
   * Claim the next fresh-ordinary FIFO position synchronously. Callers reserve
   * the slot before resolving author context so arrival order — not author
   * lookup latency — determines which fresh turn runs first.
   */
  reserveFreshOrdinarySlot(): FreshOrdinaryTurnSlot {
    const predecessor = this.freshOrdinaryIngressTail;
    let release!: () => void;
    this.freshOrdinaryIngressTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      release();
    };
    return {
      run: async (message: SubstrateMessage): Promise<void> => {
        try {
          await predecessor;
          // Coordinator-created fresh ordinary turns must flush deferred internal
          // whispers too; otherwise a fresh-turn-only sequence (idle steer/followUp)
          // never delivers a whisper that public handleMessage would have flushed.
          this.enqueuePendingInternalFollowUpsForOrdinaryRun();
          await this.options.runFreshOrdinary(message);
        } finally {
          settle();
        }
      },
      dispose: settle,
    };
  }

  assertCandidateQueueEmpty(): void {
    if (!this.options.agent.hasQueuedMessages()) return;
    throw new Error(
      'Trusted ICP candidate turn refused while ordinary Agent queue ingress remains pending',
    );
  }
}
