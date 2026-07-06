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
import { RUNTIME_LAYOUT_MODE } from '../../../persistence/layout.js';
import { verifyConcernSofteningStartupConfig } from '../../../core/intention/concern-softening.js';

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

function assertStaticStartupConfigs(env: NodeJS.ProcessEnv): void {
  const concernSofteningResult = verifyConcernSofteningStartupConfig({
    configDir: env.CONFIG_DIR,
  });
  if (concernSofteningResult.ok) return;

  throw new Error([
    'Static startup config validation failed:',
    ...concernSofteningResult.errors.map(error => `- ${error}`),
  ].join('\n'));
}

export function resolveStartupLifecycleBundle(
  options: ResolveStartupLifecycleOptions,
): StartupLifecycleBundle {
  const env = options.env ?? process.env;
  const lifecycleRuntimeContract = resolveRuntimeModeContract({
    entrypoint: options.entrypoint,
    runtimeModeEnv: env.PSFN_RUNTIME_MODE,
    restartCommandEnv: env.LIFECYCLE_RESTART_COMMAND,
    restartExitCodeEnv: env.PSFN_LIFECYCLE_RESTART_EXIT_CODE,
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
  assertStaticStartupConfigs(env);
  const startupHydration = hydrateCanonicalStartupConfig(config, {
    env,
    secretAuthority: options.secretAuthority,
  });

  if (
    startupHydration.pathSnapshot.runtimePathLayout.mode === RUNTIME_LAYOUT_MODE.PRODUCTION
    && !env.WORKSPACE_PATH?.trim()
  ) {
    throw new Error(
      'WORKSPACE_PATH is required for production runtime startup. ' +
      'Set WORKSPACE_PATH to the explicit personal files root.',
    );
  }

  return {
    ignoredMutableEnvKeys,
    startupHydration,
    ...resolveStartupLifecycleBundle({
      entrypoint: options.entrypoint,
      env,
    }),
  };
}
