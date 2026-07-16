#!/usr/bin/env tsx

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import '../../shared/utils/load-dotenv.js';
import {
  isMultiCompanionEnabled,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
} from '../../system/config/companions-config.js';
import { PER_COMPANION_OWNER_FILES } from '../../system/config/settings-contract.js';
import {
  CHARGE_POLICY_FILE_NAME,
  loadChargePolicyConfig,
} from '../../system/config/charge-policy-config.js';
import { loadSkillsConfig, SKILLS_FILE_NAME } from '../../system/config/skills-config.js';
import { resolveRuntimePathLayout } from '../../persistence/layout.js';
import {
  buildSystemOwnerFleetMigrationPlan,
  executeSystemOwnerFleetMigration,
} from '../../persistence/system-owner-fleet-migration.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  approvals: Record<string, string>;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:system-owner-fleet [-- OPTIONS]');
  console.log('');
  console.log('Plans or applies the explicit system-owner to fleet-companion fan-out migration.');
  console.log('Stop the fleet before applying. The default mode is a read-only plan.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                         Execute the migration');
  console.log('  --approve <owner-file>=<sha256> Approve one exact source digest (repeat per source)');
  console.log('  -h, --help                      Show this help message');
}

function parseApproval(raw: string): [string, string] {
  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw new Error('--approve must use <owner-file>=<sha256>');
  }
  const ownerFile = raw.slice(0, separator).trim();
  const digest = raw.slice(separator + 1).trim();
  if (!PER_COMPANION_OWNER_FILES.has(ownerFile)) {
    throw new Error(`--approve owner file is not registered per-companion: ${ownerFile}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`--approve digest for ${ownerFile} must be an exact lowercase SHA-256`);
  }
  return [ownerFile, digest];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, approvals: {}, showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--approve') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --approve');
      const [ownerFile, digest] = parseApproval(value);
      if (options.approvals[ownerFile]) {
        throw new Error(`Duplicate --approve for ${ownerFile}`);
      }
      options.approvals[ownerFile] = digest;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveMigrationContext(env: NodeJS.ProcessEnv) {
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
    throw new Error('System-owner fleet migration requires production split roots');
  }
  const rawFleet = resolveCompanionFleet({
    dataDir: layout.systemDataDir,
    multiCompanion: isMultiCompanionEnabled(env),
    seedDir: env.CONFIG_DIR?.trim() || undefined,
  });
  if (!rawFleet) {
    throw new Error('System-owner fleet migration requires an enabled companions.json fleet');
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

/**
 * Validate schema-bound owners before the receipt transaction can create any
 * destination or retire a source. Scheduler is intentionally excluded here:
 * the supported old-release flow copies its pre-bundled schema byte-for-byte
 * before the separately guarded scheduler owner migrator upgrades the shape.
 */
function validateSchemaBoundMigrationSources(
  systemDataDir: string,
  seedDir: string | undefined,
): void {
  if (existsSync(join(systemDataDir, CHARGE_POLICY_FILE_NAME))) {
    loadChargePolicyConfig(systemDataDir, seedDir ? { seedDir } : undefined);
  }
  if (existsSync(join(systemDataDir, SKILLS_FILE_NAME))) {
    loadSkillsConfig(systemDataDir, seedDir ? { seedDir } : undefined);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }
  const { layout, fleet } = resolveMigrationContext(process.env);
  validateSchemaBoundMigrationSources(
    layout.systemDataDir,
    process.env.CONFIG_DIR?.trim() || undefined,
  );
  if (options.apply) {
    const result = executeSystemOwnerFleetMigration({
      systemDataDir: layout.systemDataDir,
      fleet,
      expectedSourceDigests: options.approvals,
    });
    console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
    return;
  }
  if (Object.keys(options.approvals).length > 0) {
    throw new Error('--approve is accepted only with --apply');
  }
  const plan = buildSystemOwnerFleetMigrationPlan({
    systemDataDir: layout.systemDataDir,
    fleet,
  });
  console.log(JSON.stringify({
    mode: 'dry-run',
    ...plan,
    approvals: plan.files
      .filter(file => file.sourceSha256)
      .map(file => `--approve ${file.ownerFile}=${file.sourceSha256}`),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`System-owner fleet migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
