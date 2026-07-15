import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import {
  isMultiCompanionEnabled,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  type ResolvedCompanionsFleetConfig,
} from '../src/system/config/companions-config.js';

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
