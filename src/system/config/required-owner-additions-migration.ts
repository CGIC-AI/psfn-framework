import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import {
  assertPinnedDirectoryAtLogicalPath,
  closePinnedDirectory,
  pinAbsoluteDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  readPinnedRegularFile,
  setPinnedRegularFileMode,
} from '../../persistence/pinned-filesystem.js';
import { migrateRequiredSettingsBlocks } from '../settings/required-blocks-owner-migration.js';
import { migrateIntakePolicyOwner } from './intake-policy-owner-migration.js';
import { migrateAutomataPolicyOwner } from './automata-policy-owner-migration.js';
import {
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SEED_FILE_NAME,
  validateIntakePolicy,
} from './intake-policy-config.js';
import {
  AUTOMATA_FILE_NAME,
  AUTOMATA_SEED_FILE_NAME,
} from './automata-policy-config.js';
import { parseAutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
import {
  PARTNER_AFFECT_SHADOW_FILE_NAME,
  PARTNER_AFFECT_SHADOW_SEED_FILE_NAME,
  validatePartnerAffectShadowConfig,
} from './partner-affect-shadow-config.js';
import { canonicalOwnerFileMode } from './owner-file-modes.js';

export interface RequiredOwnerAdditionsMigrationOptions {
  dataDir: string;
  companionDataDir?: string;
  seedDir?: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface RequiredCompanionOwnerAdditionsMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  directoryPath: string;
  addedPaths?: string[];
  updatedPaths?: string[];
}

export interface RequiredOwnerAdditionsMigrationResult {
  mode: 'dry-run' | 'apply';
  settings: ReturnType<typeof migrateRequiredSettingsBlocks>;
  intakePolicy: ReturnType<typeof migrateIntakePolicyOwner> | RequiredSystemOwnerAdditionResult;
  automataPolicy: ReturnType<typeof migrateAutomataPolicyOwner> | RequiredSystemOwnerAdditionResult;
  companionOwnerAdditions?: RequiredCompanionOwnerAdditionsMigrationResult;
}

interface RequiredSystemOwnerAdditionResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  addedPaths: string[];
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function migrateMissingRequiredSystemOwner(options: {
  dataDir: string;
  seedDir: string;
  ownerFileName: string;
  seedFileName: string;
  apply: boolean;
  validate: (raw: unknown, sourcePath: string) => unknown;
  faultInjection?: DurableWriteOptions['faultInjection'];
}): RequiredSystemOwnerAdditionResult | null {
  const directory = pinAbsoluteDirectory(options.dataDir, 'System owner data directory');
  const seedDirectory = pinAbsoluteDirectory(options.seedDir, 'Owner seed directory');
  try {
    if (pinnedLeafExists(directory, options.ownerFileName)) return null;
    const seed = readPinnedRegularFile(
      seedDirectory,
      options.seedFileName,
      `${options.ownerFileName} seed file`,
    );
    options.validate(
      JSON.parse(seed.content.toString('utf8')) as unknown,
      join(options.seedDir, options.seedFileName),
    );
    const filePath = join(options.dataDir, options.ownerFileName);
    const result: RequiredSystemOwnerAdditionResult = {
      mode: options.apply ? 'apply' : 'dry-run',
      status: options.apply ? 'applied' : 'planned',
      filePath,
      addedPaths: [options.ownerFileName],
    };
    if (!options.apply) {
      assertPinnedDirectoryAtLogicalPath(directory, 'System owner data directory');
      return result;
    }
    try {
      writeFileDurableAtomicSync(
        pinnedLeafPath(directory, options.ownerFileName),
        seed.content,
        {
          exclusive: true,
          mode: canonicalOwnerFileMode({
            ownerFileName: options.ownerFileName,
            scope: 'system',
          }),
          faultInjection: (stage) => options.faultInjection?.(stage, filePath),
        },
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      result.status = 'not_needed';
      result.addedPaths = [];
    }
    assertPinnedDirectoryAtLogicalPath(directory, 'System owner data directory');
    const published = readPinnedRegularFile(
      directory,
      options.ownerFileName,
      `${options.ownerFileName} owner file`,
    );
    options.validate(JSON.parse(published.content.toString('utf8')) as unknown, filePath);
    return result;
  } finally {
    closePinnedDirectory(seedDirectory);
    closePinnedDirectory(directory);
  }
}

function migrateRequiredCompanionOwnerAdditions(options: {
  companionDataDir: string;
  seedDir: string;
  apply: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}): RequiredCompanionOwnerAdditionsMigrationResult {
  const mode = options.apply ? 'apply' : 'dry-run';
  const directory = pinAbsoluteDirectory(
    options.companionDataDir,
    'Companion owner data directory',
  );
  const seedDirectory = pinAbsoluteDirectory(options.seedDir, 'Owner seed directory');
  try {
    if (pinnedLeafExists(directory, PARTNER_AFFECT_SHADOW_FILE_NAME)) {
      const existing = readPinnedRegularFile(
        directory,
        PARTNER_AFFECT_SHADOW_FILE_NAME,
        'Partner Affect shadow owner file',
      );
      validatePartnerAffectShadowConfig(
        JSON.parse(existing.content.toString('utf8')) as unknown,
        join(options.companionDataDir, PARTNER_AFFECT_SHADOW_FILE_NAME),
      );
      assertPinnedDirectoryAtLogicalPath(directory, 'Companion owner data directory');
      const canonicalMode = canonicalOwnerFileMode({
        ownerFileName: PARTNER_AFFECT_SHADOW_FILE_NAME,
        scope: 'companion',
      });
      if (existing.mode !== canonicalMode) {
        if (options.apply) {
          setPinnedRegularFileMode(
            directory,
            PARTNER_AFFECT_SHADOW_FILE_NAME,
            'Partner Affect shadow owner file',
            canonicalMode,
            existing,
          );
        }
        return {
          mode,
          status: options.apply ? 'applied' : 'planned',
          directoryPath: options.companionDataDir,
          updatedPaths: ['partner-affect-shadow.json mode'],
        };
      }
      return { mode, status: 'not_needed', directoryPath: options.companionDataDir };
    }

    const seed = readPinnedRegularFile(
      seedDirectory,
      PARTNER_AFFECT_SHADOW_SEED_FILE_NAME,
      'Partner Affect shadow seed file',
    );
    validatePartnerAffectShadowConfig(
      JSON.parse(seed.content.toString('utf8')) as unknown,
      join(options.seedDir, PARTNER_AFFECT_SHADOW_SEED_FILE_NAME),
    );
    const result: RequiredCompanionOwnerAdditionsMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      directoryPath: options.companionDataDir,
      addedPaths: [PARTNER_AFFECT_SHADOW_FILE_NAME],
    };
    if (!options.apply) {
      assertPinnedDirectoryAtLogicalPath(directory, 'Companion owner data directory');
      return result;
    }

    const filePath = join(options.companionDataDir, PARTNER_AFFECT_SHADOW_FILE_NAME);
    try {
      writeFileDurableAtomicSync(
        pinnedLeafPath(directory, PARTNER_AFFECT_SHADOW_FILE_NAME),
        seed.content,
        {
          exclusive: true,
          mode: canonicalOwnerFileMode({
            ownerFileName: PARTNER_AFFECT_SHADOW_FILE_NAME,
            scope: 'companion',
          }),
          faultInjection: (stage) => options.faultInjection?.(stage, filePath),
        },
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      result.status = 'not_needed';
      result.addedPaths = [];
    }
    assertPinnedDirectoryAtLogicalPath(directory, 'Companion owner data directory');
    const published = readPinnedRegularFile(
      directory,
      PARTNER_AFFECT_SHADOW_FILE_NAME,
      'Partner Affect shadow owner file',
    );
    validatePartnerAffectShadowConfig(
      JSON.parse(published.content.toString('utf8')) as unknown,
      filePath,
    );
    return result;
  } finally {
    closePinnedDirectory(seedDirectory);
    closePinnedDirectory(directory);
  }
}

function runRequiredOwnerAdditions(
  options: RequiredOwnerAdditionsMigrationOptions,
  apply: boolean,
): RequiredOwnerAdditionsMigrationResult {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const intakeAddition = migrateMissingRequiredSystemOwner({
    dataDir: options.dataDir,
    seedDir,
    ownerFileName: INTAKE_POLICY_FILE_NAME,
    seedFileName: INTAKE_POLICY_SEED_FILE_NAME,
    apply,
    validate: validateIntakePolicy,
    faultInjection: options.faultInjection,
  });
  const automataAddition = migrateMissingRequiredSystemOwner({
    dataDir: options.dataDir,
    seedDir,
    ownerFileName: AUTOMATA_FILE_NAME,
    seedFileName: AUTOMATA_SEED_FILE_NAME,
    apply,
    validate: parseAutomataOwnerPolicy,
    faultInjection: options.faultInjection,
  });
  return {
    mode: apply ? 'apply' : 'dry-run',
    settings: migrateRequiredSettingsBlocks({
      dataDir: options.dataDir,
      seedDir,
      apply,
      faultInjection: options.faultInjection,
    }),
    intakePolicy: intakeAddition ?? migrateIntakePolicyOwner({
        dataDir: options.dataDir,
        seedDir,
        apply,
        faultInjection: options.faultInjection,
      }),
    automataPolicy: automataAddition ?? migrateAutomataPolicyOwner({
        dataDir: options.dataDir,
        seedDir,
        apply,
        faultInjection: options.faultInjection,
      }),
    ...(options.companionDataDir
      ? {
        companionOwnerAdditions: migrateRequiredCompanionOwnerAdditions({
          companionDataDir: options.companionDataDir,
          seedDir,
          apply,
          faultInjection: options.faultInjection,
        }),
      }
      : {}),
  };
}

/**
 * Preflight and apply every additive owner migration required before strict
 * startup. The stable deployment command remains migrate-required-settings-blocks.
 */
export function migrateRequiredOwnerAdditions(
  options: RequiredOwnerAdditionsMigrationOptions,
): RequiredOwnerAdditionsMigrationResult {
  if (!options.apply) return runRequiredOwnerAdditions(options, false);
  runRequiredOwnerAdditions(options, false);
  return runRequiredOwnerAdditions(options, true);
}
