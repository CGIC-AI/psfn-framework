import { resolveConfiguredCompanionDataDir, type ConfiguredPersistenceDirs } from '../../persistence/layout.js';
import { PromptRuntimeLayoutStore, resolvePromptRuntimeLayoutPath } from './prompt-runtime.js';

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

export function resolveCachedPromptRuntimeLayoutStore(
  config: ConfiguredPersistenceDirs,
): PromptRuntimeLayoutStore {
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  const filePath = resolvePromptRuntimeLayoutPath(companionDataDir);
  return getCachedPromptRuntimeLayoutStore(filePath, () => new PromptRuntimeLayoutStore(filePath));
}
