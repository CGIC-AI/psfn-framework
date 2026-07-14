import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Gives trusted candidate turns exclusive ownership of the complete agent run,
 * while preserving the existing ability for ordinary turns to overlap.
 *
 * The reservation is intentionally acquired before any candidate-origin lookup
 * or tool-surface activation so no other turn can observe or mutate transient
 * per-turn state. Re-entry from the active owner fails instead of deadlocking.
 */
export class TurnRunReservation {
  private readonly queue: Array<{
    mode: 'shared' | 'exclusive';
    grant: () => void;
  }> = [];
  private activeReaders = 0;
  private writerActive = false;
  private readonly activeOwner = new AsyncLocalStorage<symbol>();
  private readonly liveOwners = new Set<symbol>();

  async runShared<T>(run: () => Promise<T>): Promise<T> {
    return this.runWithReservation('shared', run);
  }

  async runExclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.runWithReservation('exclusive', run);
  }

  private async runWithReservation<T>(
    mode: 'shared' | 'exclusive',
    run: () => Promise<T>,
  ): Promise<T> {
    const inheritedOwner = this.activeOwner.getStore();
    if (inheritedOwner && this.liveOwners.has(inheritedOwner)) {
      throw new Error('Agent turn ownership cannot be re-entered by the active run');
    }

    await new Promise<void>((grant) => {
      this.queue.push({ mode, grant });
      this.drain();
    });
    const owner = Symbol('agent-turn-owner');
    this.liveOwners.add(owner);
    try {
      return await this.activeOwner.run(owner, run);
    } finally {
      this.liveOwners.delete(owner);
      if (mode === 'exclusive') {
        this.writerActive = false;
      } else {
        this.activeReaders -= 1;
      }
      this.drain();
    }
  }

  private drain(): void {
    if (this.writerActive) return;

    if (this.activeReaders === 0 && this.queue[0]?.mode === 'exclusive') {
      const next = this.queue.shift();
      if (!next) return;
      this.writerActive = true;
      next.grant();
      return;
    }

    while (this.queue[0]?.mode === 'shared') {
      const next = this.queue.shift();
      if (!next) return;
      this.activeReaders += 1;
      next.grant();
    }
  }
}
