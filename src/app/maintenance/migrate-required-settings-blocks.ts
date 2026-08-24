#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { migrateRequiredOwnerAdditions } from '../../system/config/required-owner-additions-migration.js';

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dataDirIndex = args.indexOf('--data-dir');
  if (dataDirIndex < 0 || !args[dataDirIndex + 1]) {
    throw new Error('--data-dir is required; pass the exact system owner-file directory');
  }
  const dataDir = args[dataDirIndex + 1];
  if (!dataDir) {
    throw new Error('--data-dir is required; pass the exact system owner-file directory');
  }
  const companionDataDirIndex = args.indexOf('--companion-data-dir');
  const companionDataDir = companionDataDirIndex >= 0
    ? args[companionDataDirIndex + 1]
    : undefined;
  if (companionDataDirIndex >= 0 && !companionDataDir) {
    throw new Error('--companion-data-dir requires the exact companion owner-file directory');
  }
  const known = new Set([
    '--apply',
    '--dry-run',
    '--data-dir',
    dataDir,
    '--companion-data-dir',
    ...(companionDataDir ? [companionDataDir] : []),
  ]);
  const unknown = args.find(arg => !known.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  console.log(JSON.stringify(migrateRequiredOwnerAdditions({
    dataDir: resolve(dataDir),
    ...(companionDataDir ? { companionDataDir: resolve(companionDataDir) } : {}),
    apply,
  }), null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Required owner additions migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
