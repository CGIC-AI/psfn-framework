import { AsyncLocalStorage } from 'node:async_hooks';

export type TurnRunOwnerKind = 'ordinary-turn' | 'candidate-turn' | 'queued-ingress';

export type TurnRunOwnerAttribution = {
  kind: Exclude<TurnRunOwnerKind, 'queued-ingress'>;
  sourceId: string;
} | {
  kind: 'queued-ingress';
  sourceId: string;
  ingress: 'follow-up' | 'steer' | 'observation';
};

export interface TurnIngressLease {
  deferredFromExclusive: boolean;
  owner: TurnRunOwnerAttribution;
}

interface TurnRunOwnerContext {
  attribution: TurnRunOwnerAttribution;
  active: boolean;
}

interface TurnRunWaiter {
  mode: 'shared' | 'exclusive';
  owner: TurnRunOwnerContext;
  grant: () => void;
}

/**
 * Gives trusted candidate turns exclusive ownership of the complete agent run,
 * while preserving the existing ability for ordinary turns to overlap.
 *
 * Candidate descendants remain attributed to their candidate owner after the
 * callback settles, so detached async work cannot re-enter through another
 * public ingress. External queued input waits behind the candidate and receives
 * a fresh ordinary owner before it is processed.
 */
export class TurnRunReservation {
  private readonly queue: TurnRunWaiter[] = [];
  private activeReaders = 0;
  private writerActive = false;
  private activeWriterOwner: TurnRunOwnerContext | null = null;
  private readonly activeOwner = new AsyncLocalStorage<TurnRunOwnerContext>();

  async runShared<T>(
    owner: TurnRunOwnerAttribution,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.runWithReservation('shared', owner, run);
  }

  async runExclusive<T>(
    owner: TurnRunOwnerAttribution,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.runWithReservation('exclusive', owner, run);
  }

  async runIngress<T>(
    owner: TurnRunOwnerAttribution,
    run: (lease: TurnIngressLease) => Promise<T>,
  ): Promise<T> {
    const inheritedOwner = this.activeOwner.getStore();
    this.assertNotCandidateDescendant(inheritedOwner);

    if (inheritedOwner?.active) {
      return run({
        deferredFromExclusive: false,
        owner: inheritedOwner.attribution,
      });
    }

    const deferredFromExclusive = this.writerActive
      || this.queue.some(waiter => waiter.mode === 'exclusive');
    return this.runWithReservation(
      deferredFromExclusive ? 'exclusive' : 'shared',
      owner,
      () => run({ deferredFromExclusive, owner }),
    );
  }

  assertActiveRunMutationAllowed(operation: string): void {
    const inheritedOwner = this.activeOwner.getStore();
    this.assertNotCandidateDescendant(inheritedOwner, operation);
    if (this.activeWriterOwner?.attribution.kind === 'candidate-turn') {
      throw new Error(
        `${operation} cannot mutate a trusted ICP candidate-owned agent run`,
      );
    }
  }

  private async runWithReservation<T>(
    mode: 'shared' | 'exclusive',
    ownerAttribution: TurnRunOwnerAttribution,
    run: () => Promise<T>,
  ): Promise<T> {
    const inheritedOwner = this.activeOwner.getStore();
    this.assertNotCandidateDescendant(inheritedOwner);
    if (inheritedOwner?.active) {
      throw new Error('Agent turn ownership cannot be re-entered by the active run');
    }

    const owner: TurnRunOwnerContext = {
      attribution: ownerAttribution,
      active: false,
    };
    await new Promise<void>((grant) => {
      this.queue.push({ mode, owner, grant });
      this.drain();
    });
    try {
      return await this.activeOwner.run(owner, run);
    } finally {
      owner.active = false;
      if (mode === 'exclusive') {
        this.writerActive = false;
        this.activeWriterOwner = null;
      } else {
        this.activeReaders -= 1;
      }
      this.drain();
    }
  }

  private assertNotCandidateDescendant(
    owner: TurnRunOwnerContext | undefined,
    operation = 'Agent ingress',
  ): void {
    if (owner?.attribution.kind === 'candidate-turn') {
      throw new Error(
        `${operation} cannot escape its trusted ICP candidate turn owner`,
      );
    }
  }

  private drain(): void {
    if (this.writerActive) return;

    if (this.activeReaders === 0 && this.queue[0]?.mode === 'exclusive') {
      const next = this.queue.shift();
      if (!next) return;
      next.owner.active = true;
      this.writerActive = true;
      this.activeWriterOwner = next.owner;
      next.grant();
      return;
    }

    while (this.queue[0]?.mode === 'shared') {
      const next = this.queue.shift();
      if (!next) return;
      next.owner.active = true;
      this.activeReaders += 1;
      next.grant();
    }
  }
}
