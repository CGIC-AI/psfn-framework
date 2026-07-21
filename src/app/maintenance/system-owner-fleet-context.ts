import {
  companionsFileExists,
  loadCompanionsConfig,
  resolveCompanionFleetPaths,
  type CompanionsFleetConfig,
} from '../../system/config/companions-config.js';
import { resolveRuntimePathLayout } from '../../persistence/layout.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { join, relative } from 'node:path';

function resolveSingleCompanionConfig(input: {
  companionId: string | undefined;
  runtimeRootDir: string;
  companionDataDir: string;
}): CompanionsFleetConfig {
  const companionId = createCompanionId(
    input.companionId,
    'COMPANION_ID for single-companion system-owner migration',
  );
  const companionDataDir = relative(input.runtimeRootDir, input.companionDataDir);
  if (!companionDataDir || companionDataDir.startsWith('..')) {
    throw new Error(
      'Single-companion system-owner migration requires COMPANION_DATA_DIR beneath PSFN_RUNTIME_ROOT',
    );
  }
  return {
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env',
        envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [{
      companionId,
      companionDataDir,
      characterCardPath: join(companionDataDir, 'companion.json'),
      postgresSchema: 'public',
      postgresRole: 'single_companion_runtime',
      postgresDatabaseUrlRef: {
        kind: 'env',
        envName: 'SINGLE_COMPANION_DATABASE_URL',
      },
    }],
  };
}

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
  // Owner-migration tooling can run against an existing pre-manifest single
  // install (companions.json not yet created). When the manifest is present it
  // is authoritative; when absent this synthesizes the one-entry migration
  // fleet from the environment so the install can be migrated into the fleet
  // owner-file world. Runtime startup (load-config) still requires the manifest.
  const seedDir = env.CONFIG_DIR?.trim() || undefined;
  const rawFleet = companionsFileExists(layout.systemDataDir)
    ? loadCompanionsConfig(layout.systemDataDir, seedDir ? { seedDir } : undefined)
    : resolveSingleCompanionConfig({
      companionId: env.COMPANION_ID,
      runtimeRootDir: layout.runtimeRootDir,
      companionDataDir: layout.companionDataDir,
    });
  const fleet = resolveCompanionFleetPaths(rawFleet, layout.runtimeRootDir, [
    { label: 'systemDataDir', path: layout.systemDataDir },
    { label: 'companionDataDir', path: layout.companionDataDir },
    { label: 'logsDir', path: layout.logsDir },
    { label: 'tempDir', path: layout.tempDir },
    { label: 'backupsDir', path: layout.backupsDir },
  ]);
  return { layout, fleet };
}
