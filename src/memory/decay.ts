import type { MemoryStore } from './store.js';
import { DECAY_HALFLIFE, MEMORY_CONFIG, getMemoryDecayProfile } from './types.js';
import type { MemoryType } from './types.js';

interface SalienceDecayOptions {
  batchSize?: number;
}

export class SalienceDecay {
  private memoryStore: MemoryStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;

  constructor(memoryStore: MemoryStore, options: SalienceDecayOptions = {}) {
    this.memoryStore = memoryStore;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
  }

  start(intervalMs: number = MEMORY_CONFIG.maintenanceIntervalMs): void {
    this.stop();
    this.timer = setInterval(() => {
      this.run();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  run(): void {
    const now = Date.now();

    this.memoryStore.runInTransaction(() => {
      let offset = 0;
      while (true) {
        const memories = this.memoryStore.listActiveMemories({
          limit: this.batchSize,
          offset,
        });
        if (memories.length === 0) break;

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
            this.memoryStore.updateMemory(memory.id, { salience: newSalience });
          }
        }

        if (memories.length < this.batchSize) break;
        offset += memories.length;
      }
    });
  }
}
