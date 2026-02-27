import type { MemoryStore } from './store.js';
import { DECAY_HALFLIFE, MEMORY_CONFIG, getMemoryDecayProfile } from './types.js';
import type { MemoryType } from './types.js';

export class SalienceDecay {
  private memoryStore: MemoryStore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(memoryStore: MemoryStore) {
    this.memoryStore = memoryStore;
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
    const memories = this.memoryStore.getAllActiveMemories();

    this.memoryStore.runInTransaction(() => {
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
    });
  }
}
