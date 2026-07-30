import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { PER_COMPANION_OWNER_FILES } from '../src/system/config/settings-contract.js';
import {
  describeStartupOwnerFileChecks,
  verifyStartupOwnerFiles,
} from '../src/system/config/startup-owner-files.js';

/**
 * Seed→owner pairs staged into an isolated split fixture before running the
 * startup owner-file guard. Every owner that {@link verifyStartupOwnerFiles}
 * requires when its file is missing must appear here; owners the guard tolerates
 * as absent (see OPTIONAL_WHEN_MISSING_OWNER_FILES) must not, because their
 * distributed seeds are placeholders that fail closed until provisioned.
 *
 * This literal is cross-checked against the guard's own owner-check list by
 * {@link assertOwnerFileSeedParity}; drift (a new required owner the guard adds
 * but this list omits, a stale entry, or a mismatched seed name) fails loudly
 * instead of masking a real seed regression.
 */
export const OWNER_FILE_SEEDS = [
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
  ['companions.seed.json', 'companions.json'],
  ['partner-affect-shadow.seed.json', 'partner-affect-shadow.json'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const REPOSITORY_CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url));

/**
 * Fail with a specific drift error if OWNER_FILE_SEEDS is out of parity with the
 * owner checks {@link verifyStartupOwnerFiles} actually runs. This makes the
 * "the script forgot to stage a newly-required owner" class of bug (which left
 * `verify:startup-owner-files` red on clean main; psfn-framework-jxj0d)
 * impossible to reintroduce silently.
 */
export function assertOwnerFileSeedParity(
  stagedSeeds: ReadonlyArray<readonly [string, string]> = OWNER_FILE_SEEDS,
): void {
  const checks = describeStartupOwnerFileChecks();
  const requiredByOwner = new Map<string, string>();
  const seedByOwner = new Map<string, string>();
  for (const check of checks) {
    seedByOwner.set(check.ownerFileName, check.seedFileName);
    if (!check.optionalWhenMissing) {
      requiredByOwner.set(check.ownerFileName, check.seedFileName);
    }
  }

  const stagedOwners = new Set(stagedSeeds.map(([, owner]) => owner));

  const missing = [...requiredByOwner.entries()]
    .filter(([owner]) => !stagedOwners.has(owner))
    .map(([owner, seed]) => `${owner} (seed ${seed})`);
  if (missing.length > 0) {
    throw new Error(
      'OWNER_FILE_SEEDS drifted from verifyStartupOwnerFiles: missing required owner '
      + `seed staging for ${missing.join(', ')}. Add the seed->owner pair(s) to `
      + 'OWNER_FILE_SEEDS in scripts/verify-startup-owner-files.ts.',
    );
  }

  for (const [seed, owner] of stagedSeeds) {
    const expectedSeed = seedByOwner.get(owner);
    if (expectedSeed === undefined) {
      throw new Error(
        `OWNER_FILE_SEEDS stages ${owner} (seed ${seed}) but verifyStartupOwnerFiles `
        + 'runs no such owner check. Remove the stale entry from '
        + 'scripts/verify-startup-owner-files.ts or add the check to the guard.',
      );
    }
    if (expectedSeed !== seed) {
      throw new Error(
        `OWNER_FILE_SEEDS stages ${owner} from ${seed}, but verifyStartupOwnerFiles `
        + `expects seed ${expectedSeed}. Align the seed name in `
        + 'scripts/verify-startup-owner-files.ts with the guard.',
      );
    }
  }
}

export function verifyRepositoryOwnerFileSeeds(): StartupOwnerFileSeedVerdict {
  assertOwnerFileSeedParity();

  const seedDir = REPOSITORY_CONFIG_DIR;
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

    return verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir,
      seedDir,
      defaultContextWindow: 128_000,
      fleetAuth: false,
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

interface StartupOwnerFileSeedVerdict {
  ok: boolean;
  errors: string[];
}

function main(): void {
  const result = verifyRepositoryOwnerFileSeeds();
  if (!result.ok) {
    process.stderr.write('Repository owner-file seed validation failed:\n');
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Repository owner-file seed validation passed in an isolated split fixture.\n');
}

const invokedDirectly =
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write('Repository owner-file seed validation failed:\n');
    process.stderr.write(`- ${message}\n`);
    process.exitCode = 1;
  }
}
