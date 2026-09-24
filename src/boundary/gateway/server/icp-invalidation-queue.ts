// Per-companion ICP autonomy permit invalidation queue. Invalidations for one
// companion are chained in order; a reconnecting agent waits until every
// pending invalidation for its companion has succeeded (failed attempts are
// retried with the same reason) before it may bind again.
import type { GatewayServerPorts } from './ports.js';

type IcpQueuedInvalidationReason =
  | 'peer_offline'
  | 'fatigue_exhausted'
  | 'operator_cancelled'
  | 'unknown_participant';

type IcpInvalidationAttemptOutcome =
  | { readonly ok: true; readonly revokedCount: number }
  | { readonly ok: false; readonly error: unknown };

interface PendingIcpInvalidation {
  readonly reasonCode: IcpQueuedInvalidationReason;
  /** Never rejects so failed invalidations remain observable and chainable. */
  readonly completion: Promise<IcpInvalidationAttemptOutcome>;
}

export class GatewayIcpInvalidationQueue {
  readonly pendingIcpInvalidations = new Map<string, PendingIcpInvalidation>();

  constructor(
    private readonly ports: Pick<GatewayServerPorts, 'icpAutonomyBroker'>,
  ) {}

  queueIcpInvalidation(
    companionId: string,
    reasonCode: IcpQueuedInvalidationReason,
  ): Promise<number> {
    if (!this.ports.icpAutonomyBroker) return Promise.resolve(0);
    const previous = this.pendingIcpInvalidations.get(companionId);
    const attempt = (async (): Promise<number> => {
      if (previous) await previous.completion;
      const revoked = await this.ports.icpAutonomyBroker!.invalidateForCompanion(companionId, reasonCode);
      return revoked.length;
    })();
    const pending: PendingIcpInvalidation = {
      reasonCode,
      completion: attempt.then(
        (revokedCount): IcpInvalidationAttemptOutcome => ({ ok: true, revokedCount }),
        (error: unknown): IcpInvalidationAttemptOutcome => ({ ok: false, error }),
      ),
    };
    this.pendingIcpInvalidations.set(companionId, pending);
    void pending.completion.then((outcome) => {
      if (outcome.ok && this.pendingIcpInvalidations.get(companionId) === pending) {
        this.pendingIcpInvalidations.delete(companionId);
      }
    });
    return attempt;
  }

  async awaitIcpInvalidationBeforeReconnect(companionId: string): Promise<void> {
    let pending = this.pendingIcpInvalidations.get(companionId);
    while (pending) {
      const outcome = await pending.completion;
      const current = this.pendingIcpInvalidations.get(companionId);
      if (current !== pending) {
        pending = current;
        continue;
      }
      if (outcome.ok) {
        this.pendingIcpInvalidations.delete(companionId);
        return;
      }
      await this.queueIcpInvalidation(companionId, pending.reasonCode);
      pending = this.pendingIcpInvalidations.get(companionId);
    }
  }
}
