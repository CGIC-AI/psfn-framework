import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PER_COMPANION_OWNER_FILES } from '../src/system/config/settings-contract.js';
import { verifyStartupOwnerFiles } from '../src/system/config/startup-owner-files.js';

const OWNER_FILE_SEEDS = [
  ['settings.seed.json', 'settings.json'],
  ['models.seed.json', 'models.json'],
  ['providers.seed.json', 'providers.json'],
  ['trust-policy.seed.json', 'trust-policy.json'],
  ['scheduler.seed.json', 'scheduler.json'],
  ['capability-tier.seed.json', 'capability-tier.json'],
  ['charge-policy.seed.json', 'charge-policy.json'],
  ['backup.seed.json', 'backup.json'],
  ['skills.seed.json', 'skills.json'],
  ['intake-policy.seed.json', 'intake-policy.json'],
] as const;

const seedDir = resolve(process.env.CONFIG_DIR?.trim() || 'config');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'owner-seed-verification-'));
const systemDataDir = join(fixtureRoot, 'system-data');
const companionDataDir = join(fixtureRoot, 'companion-data');
mkdirSync(systemDataDir, { recursive: true });
mkdirSync(companionDataDir, { recursive: true });

try {
  for (const [seedFile, ownerFile] of OWNER_FILE_SEEDS) {
    const ownerRoot = PER_COMPANION_OWNER_FILES.has(ownerFile)
      ? companionDataDir
      : systemDataDir;
    copyFileSync(join(seedDir, seedFile), join(ownerRoot, ownerFile));
  }

  const result = verifyStartupOwnerFiles({
    dataDir: systemDataDir,
    companionDataDir,
    seedDir,
    defaultContextWindow: 128_000,
    multiCompanion: false,
    fleetAuth: false,
  });
  if (!result.ok) {
    process.stderr.write('Repository owner-file seed validation failed:\n');
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('Repository owner-file seed validation passed in an isolated split fixture.\n');
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
