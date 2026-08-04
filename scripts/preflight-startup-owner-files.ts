import '../src/shared/utils/load-dotenv.js';
import { loadOperatorConfig } from '../src/system/config/load-config.js';
import {
  verifyStartupFleetOwnerFiles,
  verifyStartupOwnerFiles,
} from '../src/system/config/startup-owner-files.js';
import { toErrorMessage } from '../src/shared/utils/errors.js';

function main(): void {
  // Operator-mode loading keeps this preflight secret-safe in every documented
  // environment: the fleet gateway supplies POSTGRES_DATABASE_URL inline,
  // agent-derived maintenance pods carry POSTGRES_DATABASE_URL_FILE or _FD,
  // and owner-file verification needs no database credential at all. The
  // credential is resolved only to satisfy config loading and is never printed.
  const config = loadOperatorConfig();
  const seedDir = process.env.CONFIG_DIR?.trim() || './config';
  const commonOptions = {
    dataDir: config.dataDir,
    seedDir,
    defaultContextWindow: config.defaultContextWindow,
  };
  const result = config.companionFleet
    ? verifyStartupFleetOwnerFiles({
      ...commonOptions,
      fleet: config.companionFleet,
    })
    : verifyStartupOwnerFiles({
      ...commonOptions,
      companionDataDir: config.companionDataDir ?? config.dataDir,
    });

  if (!result.ok) {
    process.stderr.write('Runtime startup owner-file preflight failed:\n');
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  const topology = config.companionFleet
    ? `fleet=${config.companionFleet.companions.length} companionRoots=${config.companionFleet.companions.map((entry) => entry.companionDataDir).join(',')}`
    : `companion=${config.companionDataDir ?? config.dataDir}`;
  process.stdout.write(
    `Runtime startup owner-file preflight passed: system=${config.dataDir} `
    + `${topology}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Runtime startup owner-file preflight failed: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}
