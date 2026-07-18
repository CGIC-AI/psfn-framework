import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { resolveConfiguredCompanionDataDir } from '../../../persistence/layout.js';

/** Compose the per-companion authoritative capability owner for local runtimes. */
export function composeCapabilityRuntime(
  config: SubstrateConfig,
  seedDir?: string,
): CapabilityRuntime {
  return new CapabilityRuntime({
    dataDir: resolveConfiguredCompanionDataDir(config),
    ...(seedDir ? { seedDir } : {}),
  });
}
