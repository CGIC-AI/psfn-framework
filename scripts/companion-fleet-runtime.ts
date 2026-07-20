import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import {
  isMultiCompanionEnabled,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  type ResolvedCompanionsFleetConfig,
} from '../src/system/config/companions-config.js';
import {
  deriveFleetGardenTargets,
  FleetGardenTargetRegistry,
} from '../src/operator/garden/fleet-garden-target-registry.js';
import { resolveAdminTransportMode } from '../src/operator/garden/transport-paths.js';
import { readFleetAuthEnvFlag } from '../src/system/config/fleet-auth-config.js';

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
  const rawFleet = resolveCompanionFleet({
    dataDir: runtimePathLayout.systemDataDir,
    multiCompanion: isMultiCompanionEnabled(env),
    seedDir: env.CONFIG_DIR?.trim() ? env.CONFIG_DIR : undefined,
  });
  if (!rawFleet) return null;
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
  const fleetAuthFlag = readFleetAuthEnvFlag(env);
  if (fleetAuthFlag.kind === 'invalid') {
    throw new Error(
      `Invalid PSFN_FLEET_AUTH=${JSON.stringify(fleetAuthFlag.raw)}. Expected a boolean flag.`,
    );
  }
  if (fleetAuthFlag.kind !== 'set' || !fleetAuthFlag.value) {
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
