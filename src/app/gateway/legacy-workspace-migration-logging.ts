import type { LegacyWorkspaceMigrationResult } from '../../persistence/workspaces/legacy-workspace-migration.js';

interface LegacyWorkspaceMigrationLogger {
  info(message: string, metadata: Record<string, unknown>): unknown;
}

export function logLegacyWorkspaceMigrationResult(
  log: LegacyWorkspaceMigrationLogger,
  result: LegacyWorkspaceMigrationResult,
): void {
  if (result.reason === 'same_directory_identity') {
    log.info('Legacy WORKSPACE_PATH already identifies a canonical Personal Workspace; migration not needed', {
      companionId: result.companionId,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
      decision: result.reason,
    });
    return;
  }
  if (result.status === 'migrated') {
    log.info('Legacy WORKSPACE_PATH migration completed', {
      companionId: result.companionId,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
      sourceSha256: result.sourceSha256,
      decision: result.status,
    });
    return;
  }
  if (result.status === 'already_migrated') {
    log.info('Validated completed legacy WORKSPACE_PATH migration receipt', {
      companionId: result.companionId,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
      sourceSha256: result.sourceSha256,
      decision: result.status,
    });
  }
}
