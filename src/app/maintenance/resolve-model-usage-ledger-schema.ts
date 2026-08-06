import { toErrorMessage } from '../../shared/utils/errors.js';
import { loadCompanionsConfig } from '../../system/config/companions-config.js';
import { isMaintenanceCliEntrypoint } from './cli-harness.js';

export function resolveModelUsageLedgerSchema(
  systemDataDir: string,
  seedDir = process.env.CONFIG_DIR?.trim() || undefined,
): string {
  const normalizedSystemDataDir = systemDataDir.trim();
  if (!normalizedSystemDataDir) {
    throw new Error('SYSTEM_DATA_DIR is required to resolve the model-usage ledger schema');
  }
  const fleet = loadCompanionsConfig(
    normalizedSystemDataDir,
    seedDir ? { seedDir } : undefined,
  );
  const primary = fleet.companions[0];
  return primary.postgresSchema;
}

export function runModelUsageLedgerSchemaCli(env = process.env): void {
  try {
    process.stdout.write(resolveModelUsageLedgerSchema(
      env.SYSTEM_DATA_DIR ?? '',
      env.CONFIG_DIR?.trim() || undefined,
    ));
  } catch (error) {
    process.stderr.write(`Model-usage ledger schema resolution failed: ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  runModelUsageLedgerSchemaCli();
}
