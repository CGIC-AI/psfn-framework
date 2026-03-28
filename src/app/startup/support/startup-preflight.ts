import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { getIgnoredJsonBackedConfigEnvKeys } from '../../../system/config/legacy-env.js';
import {
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
  type RuntimeEntrypoint,
  type RuntimeModeContract,
  type RuntimeStatusMetadata,
} from '../../../system/lifecycle/runtime-mode.js';
import {
  hydrateCanonicalStartupConfig,
  type StartupConfigHydrationOptions,
  type StartupConfigHydrationResult,
} from './bootstrap-helpers.js';

export interface StartupPreflightLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface StartupLifecycleBundle {
  lifecycleRuntimeContract: RuntimeModeContract;
  runtimeStatusMeta: RuntimeStatusMetadata;
}

export interface StartupPreflightBundle extends StartupLifecycleBundle {
  ignoredMutableEnvKeys: string[];
  startupHydration: StartupConfigHydrationResult;
}

export interface ResolveStartupLifecycleOptions {
  entrypoint: RuntimeEntrypoint;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveStartupPreflightOptions extends StartupConfigHydrationOptions {
  entrypoint: RuntimeEntrypoint;
  logger?: StartupPreflightLogger;
}

export function resolveStartupLifecycleBundle(
  options: ResolveStartupLifecycleOptions,
): StartupLifecycleBundle {
  const env = options.env ?? process.env;
  const lifecycleRuntimeContract = resolveRuntimeModeContract({
    entrypoint: options.entrypoint,
    runtimeModeEnv: env.PSFN_RUNTIME_MODE,
    restartCommandEnv: env.LIFECYCLE_RESTART_COMMAND,
  });

  return {
    lifecycleRuntimeContract,
    runtimeStatusMeta: toRuntimeStatusMetadata(lifecycleRuntimeContract),
  };
}

export function resolveStartupPreflightBundle(
  config: SubstrateConfig,
  options: ResolveStartupPreflightOptions,
): StartupPreflightBundle {
  const env = options.env ?? process.env;
  const ignoredMutableEnvKeys = getIgnoredJsonBackedConfigEnvKeys(env);
  if (ignoredMutableEnvKeys.length > 0) {
    options.logger?.warn(
      'Ignoring JSON-owned config env vars; move runtime config into system-data JSON files and keep .env for secrets/bootstrap wiring only',
      { keys: ignoredMutableEnvKeys },
    );
  }

  return {
    ignoredMutableEnvKeys,
    startupHydration: hydrateCanonicalStartupConfig(config, { env }),
    ...resolveStartupLifecycleBundle({
      entrypoint: options.entrypoint,
      env,
    }),
  };
}
