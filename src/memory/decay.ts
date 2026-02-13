import type { MemoryStore } from './store.js';
import { DECAY_HALFLIFE, MEMORY_CONFIG } from './types.js';
import type { MemoryType } from './types.js';

export class SalienceDecay {
  private memoryStore: MemoryStore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(memoryStore: MemoryStore) {
    this.memoryStore = memoryStore;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.run();
    }, MEMORY_CONFIG.maintenanceIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  run(): void {
    const now = Date.now();
    const memories = this.memoryStore.getAllActiveMemories();

    for (const memory of memories) {
      const halflife = DECAY_HALFLIFE[memory.type as MemoryType];
      if (!halflife) continue;

      const dt = now - memory.lastAccessed;
      const decayFactor = Math.exp((-Math.LN2 * dt) / halflife);
      const newSalience = Math.max(
        MEMORY_CONFIG.salienceFloor,
        memory.salience * decayFactor,
      );

      // Only update if meaningful change
      if (Math.abs(newSalience - memory.salience) > 0.01) {
        this.memoryStore.updateMemory(memory.id, { salience: newSalience });
      }
    }
  }
}
