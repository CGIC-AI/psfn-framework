import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';

type BatchReadStore =
  Pick<MemoryStorePort, 'getById'> & Partial<Pick<MemoryStorePort, 'getByIds'>>;

/**
 * Resolve the accessible subset of memory ids through the store's batch
 * authorization primitive in a single round trip, falling back to per-id
 * {@link MemoryStorePort.getById} reads only for stores/test doubles that predate
 * `getByIds`. Both paths flow through the same (authorized) store, so the
 * returned set is identical — only the query count differs; the fallback never
 * widens access. Ids are deduplicated and results are returned in first-seen
 * input order; inaccessible or nonexistent ids are silently dropped.
 *
 * Errors propagate (fail closed): a batch authorization failure is never
 * swallowed into a per-id or raw fallback.
 */
export async function resolveMemoriesByIds(
  store: BatchReadStore,
  ids: readonly string[],
): Promise<PurrMemory[]> {
  const normalized = [...new Set(
    ids.map(id => id.trim()).filter(Boolean),
  )];
  if (normalized.length === 0) return [];
  if (typeof store.getByIds === 'function') {
    return await store.getByIds(normalized);
  }
  const resolved = await Promise.all(normalized.map(id => store.getById(id)));
  const result: PurrMemory[] = [];
  for (const memory of resolved) {
    if (memory) result.push(memory);
  }
  return result;
}
