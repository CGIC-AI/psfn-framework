import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  assertFilesystemIdentity,
  assertPinnedDirectoryAtLogicalPath,
  closePinnedDirectory,
  inspectPinnedRegularFile,
  pinAbsoluteDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  readPinnedRegularFile,
} from '../../persistence/pinned-filesystem.js';
import {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_SEED_FILE_NAME,
} from '../../shared/contracts/charge-policy.js';
import { validateChargePolicyConfig } from './charge-policy-config.js';
import { canonicalOwnerFileMode } from './owner-file-modes.js';

export interface ChargePolicyOwnerMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  addedPaths?: string[];
}

/**
 * Keys added to `fatigue.socialRegulation` after owner files were first
 * seeded (r5 initiation-pressure model). A file missing one receives the
 * seed's value; a value the operator set is never touched.
 */
const ADDED_SOCIAL_REGULATION_KEYS = [
  'mutualReplyAllowancePerSide',
  'mutualReplyPressureUnits',
] as const;

function readSeedSocialRegulation(seedDir: string): Record<string, unknown> {
  const seedDirectory = pinAbsoluteDirectory(seedDir, 'Owner seed directory');
  try {
    const seed = readPinnedRegularFile(
      seedDirectory,
      CHARGE_POLICY_SEED_FILE_NAME,
      'Charge policy seed file',
    );
    const seedPath = join(seedDir, CHARGE_POLICY_SEED_FILE_NAME);
    const validated = validateChargePolicyConfig(
      JSON.parse(seed.content.toString('utf8')) as unknown,
      seedPath,
    );
    return { ...validated.fatigue.socialRegulation };
  } finally {
    closePinnedDirectory(seedDirectory);
  }
}

/** Add the seeded values of newly required socialRegulation keys to a companion's charge-policy.json. */
export function migrateChargePolicyOwner(options: {
  companionDataDir: string;
  seedDir: string;
  apply: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}): ChargePolicyOwnerMigrationResult {
  const filePath = join(options.companionDataDir, CHARGE_POLICY_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const directory = pinAbsoluteDirectory(options.companionDataDir, 'Companion owner data directory');
  try {
    // A companion without the file is seeded whole at startup.
    if (!pinnedLeafExists(directory, CHARGE_POLICY_FILE_NAME)) {
      return { mode, status: 'not_needed', filePath };
    }
    const source = readPinnedRegularFile(directory, CHARGE_POLICY_FILE_NAME, 'Charge policy owner file');
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(directory, 'Companion owner data directory');
      const current = inspectPinnedRegularFile(directory, CHARGE_POLICY_FILE_NAME, 'Charge policy owner file');
      assertFilesystemIdentity(current, source, 'Charge policy owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Charge policy owner changed while migration was prepared: ${filePath}`);
      }
    };
    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw) || !isRecord(raw.fatigue) || !isRecord(raw.fatigue.socialRegulation)) {
      throw new Error(`Invalid charge policy at ${filePath}: fatigue.socialRegulation must be an object`);
    }
    const missing = ADDED_SOCIAL_REGULATION_KEYS.filter(
      key => (raw.fatigue as { socialRegulation: Record<string, unknown> }).socialRegulation[key] === undefined,
    );
    if (missing.length === 0) {
      validateChargePolicyConfig(raw, filePath);
      assertSourceStillCurrent();
      return { mode, status: 'not_needed', filePath };
    }
    const seedRegulation = readSeedSocialRegulation(options.seedDir);
    const candidate = structuredClone(raw) as Record<string, unknown> & {
      fatigue: Record<string, unknown> & { socialRegulation: Record<string, unknown> };
    };
    for (const key of missing) {
      candidate.fatigue.socialRegulation[key] = seedRegulation[key];
    }
    validateChargePolicyConfig(candidate, filePath);
    const result: ChargePolicyOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      addedPaths: missing.map(key => `fatigue.socialRegulation.${key}`),
    };
    if (!options.apply) {
      assertSourceStillCurrent();
      return result;
    }
    writeFileDurableAtomicSync(
      pinnedLeafPath(directory, CHARGE_POLICY_FILE_NAME),
      `${JSON.stringify(candidate, null, 2)}\n`,
      {
        mode: canonicalOwnerFileMode({ ownerFileName: CHARGE_POLICY_FILE_NAME, scope: 'companion' }),
        faultInjection: (stage) => {
          options.faultInjection?.(stage, filePath);
          if (stage !== 'after_file_sync') return;
          assertSourceStillCurrent();
        },
      },
    );
    assertPinnedDirectoryAtLogicalPath(directory, 'Companion owner data directory');
    return result;
  } finally {
    closePinnedDirectory(directory);
  }
}
