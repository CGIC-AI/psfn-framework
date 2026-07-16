import { join } from 'node:path';
import {
  CHARGE_POLICY_FILE_NAME,
  validateChargePolicyConfig,
} from '../system/config/charge-policy-config.js';
import {
  SKILLS_FILE_NAME,
  validateSkillsConfig,
} from '../system/config/skills-config.js';
import {
  assertFilesystemIdentity,
  closePinnedDirectory,
  pinRelativeDirectory,
  pinnedLeafExists,
  readPinnedRegularFile,
  relativeDirectoryPath,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import type {
  FleetReceiptEntry,
  SystemOwnerFleetMigrationReceipt,
} from './system-owner-fleet-migration-receipt.js';

const SCHEMA_BOUND_OWNER_FILES = new Set([
  CHARGE_POLICY_FILE_NAME,
  SKILLS_FILE_NAME,
]);

function parseOwnerJson(content: Buffer, sourcePath: string): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Malformed JSON in migration owner ${sourcePath}: ${String(error)}`);
  }
}

export function validatePinnedMigrationOwner(
  directory: PinnedDirectory,
  ownerFile: string,
  label: string,
): void {
  if (!SCHEMA_BOUND_OWNER_FILES.has(ownerFile)) return;
  const sourcePath = join(directory.logicalPath, ownerFile);
  const pinned = readPinnedRegularFile(directory, ownerFile, label);
  const raw = parseOwnerJson(pinned.content, sourcePath);
  if (ownerFile === CHARGE_POLICY_FILE_NAME) {
    validateChargePolicyConfig(raw, sourcePath);
  } else {
    validateSkillsConfig(raw, sourcePath);
  }
}

/**
 * Validate the canonical live owner for every schema-bound receipt file before
 * recovery creates or mutates any migration artifact. While a source remains
 * live it is authoritative. Once retirement has moved it into quarantine, the
 * current exact owner at every receipt-bound companion root is authoritative;
 * valid atomic owner evolution is therefore allowed, malformed replacements
 * are not.
 */
export function validateReceiptBoundMigrationOwners(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  fleet: readonly FleetReceiptEntry[];
  systemDirectory: PinnedDirectory;
  persistenceDirectory: PinnedDirectory;
}): void {
  const destinationDirectories = new Map<string, PinnedDirectory>();
  try {
    for (const fleetEntry of input.fleet) {
      const recordedDestinations = input.receipt.files.map(file => (
        file.destinations.find(destination => destination.companionId === fleetEntry.companionId)
      ));
      const firstDestination = recordedDestinations[0];
      if (!firstDestination
        || recordedDestinations.some(destination => !destination
          || destination.companionDataDir !== fleetEntry.companionDataDir
          || destination.companionDataDirIdentity.device
            !== firstDestination.companionDataDirIdentity.device
          || destination.companionDataDirIdentity.inode
            !== firstDestination.companionDataDirIdentity.inode)) {
        throw new Error(
          `Receipt-bound migration destination is not the exact fleet root: ${fleetEntry.companionId}`,
        );
      }
      const label = `Companion ${fleetEntry.companionId} migration destination`;
      const relativePath = relativeDirectoryPath(
        input.persistenceDirectory,
        fleetEntry.companionDataDir,
        label,
      );
      const directory = pinRelativeDirectory(
        input.persistenceDirectory,
        relativePath,
        `${label} directory`,
      );
      if (!directory) throw new Error(`${label} directory is missing`);
      destinationDirectories.set(fleetEntry.companionId, directory);
      assertFilesystemIdentity(
        directory.identity,
        firstDestination.companionDataDirIdentity,
        `${label} directory`,
      );
    }

    for (const file of input.receipt.files) {
      if (!SCHEMA_BOUND_OWNER_FILES.has(file.ownerFile)) continue;
      if (pinnedLeafExists(input.systemDirectory, file.ownerFile)) {
        validatePinnedMigrationOwner(
          input.systemDirectory,
          file.ownerFile,
          `${file.ownerFile} migration source`,
        );
        continue;
      }

      for (const destination of file.destinations) {
        const directory = destinationDirectories.get(destination.companionId);
        if (!directory) {
          throw new Error(`Missing pinned receipt destination for ${destination.companionId}`);
        }
        if (!pinnedLeafExists(directory, file.ownerFile)) {
          throw new Error(`Receipt-bound current owner is missing: ${destination.destinationPath}`);
        }
        validatePinnedMigrationOwner(
          directory,
          file.ownerFile,
          `${file.ownerFile} current receipt-bound owner`,
        );
      }
    }
  } finally {
    for (const directory of destinationDirectories.values()) closePinnedDirectory(directory);
  }
}
