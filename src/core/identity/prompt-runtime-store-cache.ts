import { PromptRuntimeLayoutStore } from './prompt-runtime.js';

const promptRuntimeLayoutStoreCache = new Map<string, PromptRuntimeLayoutStore>();

export function getCachedPromptRuntimeLayoutStore(
  filePath: string,
  factory: () => PromptRuntimeLayoutStore,
): PromptRuntimeLayoutStore {
  const cached = promptRuntimeLayoutStoreCache.get(filePath);
  if (cached) return cached;
  const created = factory();
  promptRuntimeLayoutStoreCache.set(filePath, created);
  return created;
}
