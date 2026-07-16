#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { PER_COMPANION_OWNER_FILES } from '../../system/config/settings-contract.js';
import {
  buildSystemOwnerFleetMigrationPlan,
  executeSystemOwnerFleetMigration,
} from '../../persistence/system-owner-fleet-migration.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';

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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }
  const { layout, fleet } = resolveSystemOwnerFleetContext(process.env);
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
