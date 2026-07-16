import { getRequestContext } from '../../primitives/llm/request-context.js';
import type {
  MemoryStorePort,
  MemoryStoreStats,
} from '../../faculties/memory/memory-store-port.js';
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from '../../faculties/memory/subject-authorized-store.js';

export function createSelfStatusMemoryStatsProvider(
  memoryStore: MemoryStorePort,
): () => Promise<MemoryStoreStats> {
  const subjectMemoryStore = createSubjectAuthorizedMemoryStore(
    memoryStore,
    () => memorySubjectAccessContextFromCorrelation(getRequestContext()),
  );
  return async () => await subjectMemoryStore.getStats();
}
