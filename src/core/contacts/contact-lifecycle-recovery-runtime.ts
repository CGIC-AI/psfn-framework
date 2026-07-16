import { recordLifecycleDiagnosticEvent } from '../../shared/diagnostics/runtime-diagnostics.js';
import type { ContactStorePort } from './contact-store-port.js';

const CONTACT_LIFECYCLE_RECOVERY_RUNTIME_POLICY = {
  pollIntervalMs: 5_000,
} as const;

export interface ContactLifecycleRecoveryRuntimeOptions {
  store: Pick<ContactStorePort,
    'assertContactLifecycleLedgerHealthy' | 'recoverContactLifecycleMutations'>;
  pollIntervalMs?: number;
  onFailure?: (error: unknown) => void;
}

/**
 * Runs exact startup recovery synchronously, then keeps retrying eligible work
 * through the ledger's database-owned lease protocol. The timer never overlaps
 * itself and shutdown waits for an in-flight lease batch to settle.
 */
export class ContactLifecycleRecoveryRuntime {
  private readonly store: ContactLifecycleRecoveryRuntimeOptions['store'];
  private readonly pollIntervalMs: number;
  private readonly onFailure?: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(options: ContactLifecycleRecoveryRuntimeOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs
      ?? CONTACT_LIFECYCLE_RECOVERY_RUNTIME_POLICY.pollIntervalMs)
      || (options.pollIntervalMs ?? CONTACT_LIFECYCLE_RECOVERY_RUNTIME_POLICY.pollIntervalMs) < 100) {
      throw new Error('Contact lifecycle recovery poll interval must be an integer >= 100ms');
    }
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs
      ?? CONTACT_LIFECYCLE_RECOVERY_RUNTIME_POLICY.pollIntervalMs;
    this.onFailure = options.onFailure;
  }

  async recoverBeforeExposure(): Promise<void> {
    await this.store.assertContactLifecycleLedgerHealthy();
    const outcomes = await this.store.recoverContactLifecycleMutations();
    this.recordBatch('contact_lifecycle.startup_recovery', outcomes);
  }

  start(): void {
    if (this.started || this.stopping) {
      throw new Error('Contact lifecycle recovery runtime cannot be started twice');
    }
    this.started = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.inFlight;
      return;
    }
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.runWorkerBatch().finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  private async runWorkerBatch(): Promise<void> {
    try {
      const outcomes = await this.store.recoverContactLifecycleMutations();
      this.recordBatch('contact_lifecycle.worker_recovery', outcomes);
    } catch (error) {
      recordLifecycleDiagnosticEvent({
        event: 'contact_lifecycle.worker_failure',
        component: 'contact-lifecycle',
        message: 'Contact lifecycle recovery worker failed',
      });
      this.onFailure?.(error);
    }
  }

  private recordBatch(
    event: string,
    outcomes: Awaited<ReturnType<ContactStorePort['recoverContactLifecycleMutations']>>,
  ): void {
    const completed = outcomes.filter(outcome => outcome.status === 'completed').length;
    const manualHold = outcomes.filter(outcome => outcome.status === 'manual_hold').length;
    const pending = outcomes.length - completed - manualHold;
    recordLifecycleDiagnosticEvent({
      event,
      component: 'contact-lifecycle',
      message: 'Contact lifecycle recovery batch completed',
      details: {
        claimed: outcomes.length,
        completed,
        pending,
        manualHold,
      },
    });
  }
}
