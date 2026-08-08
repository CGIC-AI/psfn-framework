#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { migrateRequiredSettingsBlocks } from '../../system/settings/required-blocks-owner-migration.js';

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
  const known = new Set(['--apply', '--dry-run', '--data-dir', dataDir]);
  const unknown = args.find(arg => !known.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  console.log(JSON.stringify(migrateRequiredSettingsBlocks({
    dataDir: resolve(dataDir),
    apply,
  }), null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Required settings blocks migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
