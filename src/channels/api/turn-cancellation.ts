import type { SubstrateAgentAbortResult } from '../../core/agent/substrate-agent.js';

export type ApiTurnCancellationReason = 'timeout' | 'client_disconnected';

export interface ActiveApiTurnRequest {
  readonly channelId: string;
  cancel(reason: ApiTurnCancellationReason): SubstrateAgentAbortResult;
}

/** Owns first-wins cancellation state while an API turn moves from queue to agent. */
export class QueuedApiTurnCancellation implements ActiveApiTurnRequest {
  private readonly controller = new AbortController();
  private phase: 'queued' | 'active' = 'queued';
  private reason: ApiTurnCancellationReason | null = null;

  constructor(
    private resolvedChannelId: string,
    private readonly abortActiveTurn: (channelId: string) => SubstrateAgentAbortResult,
  ) {}

  get channelId(): string {
    return this.resolvedChannelId;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancellationReason(): ApiTurnCancellationReason | null {
    return this.reason;
  }

  setChannelId(channelId: string): void {
    this.resolvedChannelId = channelId;
  }

  markActive(): void {
    this.phase = 'active';
  }

  claimTimeout(): boolean {
    if (this.reason !== null) return false;
    this.reason = 'timeout';
    return true;
  }

  cancel(reason: ApiTurnCancellationReason): SubstrateAgentAbortResult {
    if (this.controller.signal.aborted) return { status: 'already_aborted' };
    this.reason ??= reason;
    this.controller.abort();
    if (this.phase === 'queued') return { status: 'signaled' };
    return this.abortActiveTurn(this.resolvedChannelId);
  }
}
