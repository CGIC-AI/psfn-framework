import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ObserverEvalSidecarRuntime } from './types.js';

export function createObserverEvalSidecarRuntimeFromConfig(
  config: Pick<SubstrateConfig, 'observerEvalSidecar'>,
): ObserverEvalSidecarRuntime {
  const settings = structuredClone(
    config.observerEvalSidecar ?? createDefaultObserverEvalSidecarSettings(),
  );

  return {
    config: settings,
    observer: null,
  };
}
