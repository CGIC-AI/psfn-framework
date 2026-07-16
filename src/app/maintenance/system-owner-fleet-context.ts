import {
  isMultiCompanionEnabled,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
} from '../../system/config/companions-config.js';
import { resolveRuntimePathLayout } from '../../persistence/layout.js';

export function resolveSystemOwnerFleetContext(env: NodeJS.ProcessEnv) {
  const layout = resolveRuntimePathLayout({
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
  if (layout.systemDataDir === layout.companionDataDir) {
    throw new Error('System-owner fleet operation requires production split roots');
  }
  const rawFleet = resolveCompanionFleet({
    dataDir: layout.systemDataDir,
    multiCompanion: isMultiCompanionEnabled(env),
    seedDir: env.CONFIG_DIR?.trim() || undefined,
  });
  if (!rawFleet) {
    throw new Error('System-owner fleet operation requires an enabled companions.json fleet');
  }
  const fleet = resolveCompanionFleetPaths(rawFleet, layout.runtimeRootDir, [
    { label: 'systemDataDir', path: layout.systemDataDir },
    { label: 'companionDataDir', path: layout.companionDataDir },
    { label: 'logsDir', path: layout.logsDir },
    { label: 'tempDir', path: layout.tempDir },
    { label: 'backupsDir', path: layout.backupsDir },
  ]);
  return { layout, fleet };
}
