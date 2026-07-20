import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import {
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  type ResolvedCompanionsFleetConfig,
} from '../src/system/config/companions-config.js';
import {
  deriveFleetGardenTargets,
  FleetGardenTargetRegistry,
} from '../src/operator/garden/fleet-garden-target-registry.js';
import { resolveAdminTransportMode } from '../src/operator/garden/transport-paths.js';
import { isFleetAuthEnabled } from '../src/system/config/fleet-auth-config.js';

export interface ConfiguredLocalCompanionFleetRuntime {
  readonly fleet: ResolvedCompanionsFleetConfig;
  readonly targetRegistry: FleetGardenTargetRegistry;
}

/** Pure fleet resolution shared by the plan and post-lock provisioning steps. */
export function resolveConfiguredCompanionFleet(
  env: NodeJS.ProcessEnv,
): ResolvedCompanionsFleetConfig | null {
  const runtimePathLayout = resolveRuntimePathLayout({
    mode: env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: env.NODE_ENV,
    runtimeRootDir: env.PSFN_RUNTIME_ROOT,
    systemDataDir: env.SYSTEM_DATA_DIR,
    companionDataDir: env.COMPANION_DATA_DIR,
    legacyDataDir: env.DATA_DIR,
    workspacePath: env.WORKSPACE_PATH,
    logsDir: env.PSFN_LOGS_DIR,
    tempDir: env.PSFN_TEMP_DIR,
    backupsDir: env.BACKUP_ROOT_DIR,
  });
  // The companions.json manifest is mandatory (resolveCompanionFleet fails
  // closed if it is missing). A one-entry manifest is the single-companion
  // topology: the shell launcher runs one gateway+agent directly without the
  // fleet supervisor, so signal that with null. Only a multi-entry fleet needs
  // the local fleet target registry.
  const rawFleet = resolveCompanionFleet({
    dataDir: runtimePathLayout.systemDataDir,
    seedDir: env.CONFIG_DIR?.trim() ? env.CONFIG_DIR : undefined,
  });
  if (rawFleet.companions.length <= 1) return null;
  return resolveCompanionFleetPaths(rawFleet, runtimePathLayout.runtimeRootDir, [
    { label: 'systemDataDir', path: runtimePathLayout.systemDataDir },
    { label: 'companionDataDir', path: runtimePathLayout.companionDataDir },
    { label: 'logsDir', path: runtimePathLayout.logsDir },
    { label: 'tempDir', path: runtimePathLayout.tempDir },
    { label: 'backupsDir', path: runtimePathLayout.backupsDir },
  ]);
}

/**
 * Build the complete local fleet topology before the shell launcher starts any
 * process. The immutable registry is the same validation boundary used by the
 * fleet Garden, so an empty, malformed, or endpoint-colliding plan fails before
 * launch instead of degrading to partial connectivity.
 */
export function resolveConfiguredLocalCompanionFleetRuntime(
  env: NodeJS.ProcessEnv,
): ConfiguredLocalCompanionFleetRuntime | null {
  const fleet = resolveConfiguredCompanionFleet(env);
  if (!fleet) return null;
  if (!isFleetAuthEnabled(env)) {
    throw new Error(
      'Multi-companion local startup requires PSFN_FLEET_AUTH=1 for the one fleet Garden',
    );
  }
  if (resolveAdminTransportMode(env) !== 'socket') {
    throw new Error(
      'Multi-companion local startup requires ADMIN_TRANSPORT_MODE=socket: the fleet Garden '
      + 'target registry derives one garden-admin-<companionId>.sock endpoint per agent.',
    );
  }
  return {
    fleet,
    targetRegistry: new FleetGardenTargetRegistry(deriveFleetGardenTargets(fleet, env)),
  };
}
