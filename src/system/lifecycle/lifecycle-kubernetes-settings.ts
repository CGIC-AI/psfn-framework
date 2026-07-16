import type {
  LifecycleKubernetesSettings,
} from '../config/runtime-config-contracts.js';

export interface LifecycleKubernetesSettingsSource {
  lifecycleKubernetes?: LifecycleKubernetesSettings;
}

/**
 * Resolve the canonical settings.json policy at a live composition boundary.
 * Missing policy is a startup error; production callers must never recreate
 * module defaults after owner-file hydration.
 */
export function requireLifecycleKubernetesSettings(
  source: LifecycleKubernetesSettingsSource,
): LifecycleKubernetesSettings {
  if (!source.lifecycleKubernetes) {
    throw new Error('settings.json must define lifecycleKubernetes');
  }
  return structuredClone(source.lifecycleKubernetes);
}
