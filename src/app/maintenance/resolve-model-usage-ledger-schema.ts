import { toErrorMessage } from '../../shared/utils/errors.js';
import { loadCompanionsConfig } from '../../system/config/companions-config.js';
import { isMaintenanceCliEntrypoint } from './cli-harness.js';

export function resolveModelUsageLedgerSchema(
  systemDataDir: string,
  seedDir = process.env.CONFIG_DIR?.trim() || undefined,
  companionId?: string,
): string {
  const normalizedSystemDataDir = systemDataDir.trim();
  if (!normalizedSystemDataDir) {
    throw new Error('SYSTEM_DATA_DIR is required to resolve the model-usage ledger schema');
  }
  const fleet = loadCompanionsConfig(
    normalizedSystemDataDir,
    seedDir ? { seedDir } : undefined,
  );
  const target = companionId
    ? fleet.companions.find(companion => companion.companionId === companionId)
    : fleet.companions[0];
  if (!target && companionId) {
    throw new Error(`Model usage ledger target companion ${companionId} is not registered`);
  }
  if (!target) {
    throw new Error('Model usage ledger schema requires at least one companion entry');
  }
  return target.postgresSchema;
}

export function runModelUsageLedgerSchemaCli(env = process.env): void {
  try {
    process.stdout.write(resolveModelUsageLedgerSchema(
      env.SYSTEM_DATA_DIR ?? '',
      env.CONFIG_DIR?.trim() || undefined,
      env.PSFN_MODEL_USAGE_COMPANION_ID?.trim() || undefined,
    ));
  } catch (error) {
    process.stderr.write(`Model-usage ledger schema resolution failed: ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  runModelUsageLedgerSchemaCli();
}
