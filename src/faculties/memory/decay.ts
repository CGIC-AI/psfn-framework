import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { MemoryStorePort } from './memory-store-port.js';
import { createComponentLogger } from '../../shared/logger.js';
import { DECAY_HALFLIFE, MEMORY_CONFIG, getMemoryDecayProfile } from './types.js';
import type { MemoryType } from './types.js';

interface SalienceDecayOptions {
  batchSize?: number;
}

const log = createComponentLogger('SalienceDecay');

export class SalienceDecay {
  private memoryStore: MemoryStorePort;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly activeRuns = new Set<object>();

  constructor(memoryStore: MemoryStorePort, options: SalienceDecayOptions = {}) {
    this.memoryStore = memoryStore;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
  }

  start(intervalMs: number = MEMORY_CONFIG.maintenanceIntervalMs): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.run().catch((error) => {
        log.warn('Salience decay run failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.activeRuns.clear();
  }

  async run(): Promise<void> {
    const runState = {};
    this.activeRuns.add(runState);
    const now = Date.now();

    try {
      let offset = 0;
      for (;;) {
        if (!this.activeRuns.has(runState)) break;
        const memories = await this.memoryStore.listActiveMemories({
          limit: this.batchSize,
          offset,
        });
        if (memories.length === 0 || !this.activeRuns.has(runState)) break;

        const salienceUpdates: Array<{ id: string; salience: number }> = [];
        for (const memory of memories) {
          const profile = getMemoryDecayProfile(memory);
          const halflife = DECAY_HALFLIFE[memory.type as MemoryType] * profile.halflifeMultiplier;
          if (!halflife || halflife <= 0) continue;

          const dt = now - memory.lastAccessed;
          const decayFactor = Math.exp((-Math.LN2 * dt) / halflife);
          const newSalience = Math.max(
            profile.salienceFloor,
            memory.salience * decayFactor,
          );

          // Only update if meaningful change
          if (Math.abs(newSalience - memory.salience) > 0.01) {
            salienceUpdates.push({ id: memory.id, salience: newSalience });
          }
        }

        if (salienceUpdates.length > 0) {
          await this.memoryStore.bulkUpdateSalience(salienceUpdates);
        }

        if (!this.activeRuns.has(runState) || memories.length < this.batchSize) break;
        offset += memories.length;
        await yieldToEventLoop();
      }
    } finally {
      this.activeRuns.delete(runState);
    }
  }
}
