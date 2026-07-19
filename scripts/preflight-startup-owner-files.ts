import '../src/shared/utils/load-dotenv.js';
import { loadConfig } from '../src/system/config/load-config.js';
import {
  verifyStartupFleetOwnerFiles,
  verifyStartupOwnerFiles,
} from '../src/system/config/startup-owner-files.js';
import { toErrorMessage } from '../src/shared/utils/errors.js';

function main(): void {
  const config = loadConfig();
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
