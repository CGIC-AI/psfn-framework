export type MemoryLifecycleDisposition = 'current' | 'tombstoned' | 'superseded';

type MemoryLifecycleCandidate = {
  deletedAt?: number | null;
  supersededBy?: string | null;
};

/** Classify L2 lifecycle before ranking, counting, or prompt projection. */
export function memoryLifecycleDisposition(
  memory: MemoryLifecycleCandidate,
): MemoryLifecycleDisposition {
  if (memory.deletedAt != null) return 'tombstoned';
  if (memory.supersededBy != null) return 'superseded';
  return 'current';
}

export function isCurrentMemory(
  memory: MemoryLifecycleCandidate,
): boolean {
  return memoryLifecycleDisposition(memory) === 'current';
}

export function partitionMemoriesByLifecycle<T extends MemoryLifecycleCandidate>(
  memories: readonly T[],
): { current: T[]; tombstoned: T[]; superseded: T[] } {
  const current: T[] = [];
  const tombstoned: T[] = [];
  const superseded: T[] = [];
  for (const memory of memories) {
    switch (memoryLifecycleDisposition(memory)) {
      case 'current':
        current.push(memory);
        break;
      case 'tombstoned':
        tombstoned.push(memory);
        break;
      case 'superseded':
        superseded.push(memory);
        break;
    }
  }
  return { current, tombstoned, superseded };
}
