import { join } from 'node:path';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import {
  assertExactLinkCount,
  closePinnedDirectory,
  inspectPinnedRegularFile,
  listPinnedDirectoryNames,
  pinRelativeDirectory,
  pinnedLeafExists,
  relativeDirectoryPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import type {
  FleetReceiptEntry,
  SystemOwnerFleetMigrationDestinationPlan,
  SystemOwnerFleetMigrationFilePlan,
} from './system-owner-fleet-migration-receipt.js';
import { validatePinnedMigrationOwner } from './system-owner-fleet-owner-validation.js';

export type PinnedPlanFile = SystemOwnerFleetMigrationFilePlan & {
  sourceIdentity?: FilesystemIdentity;
};

export function migrationArtifactNames(directory: PinnedDirectory): string[] {
  return listPinnedDirectoryNames(directory).filter(name => (
    name.includes('.system-owner-fleet-reroot-')
  ));
}

export function assertNoUnknownMigrationArtifacts(
  directory: PinnedDirectory,
  label: string,
): void {
  const artifacts = migrationArtifactNames(directory);
  if (artifacts.length > 0) {
    throw new Error(`${label} contains unknown migration artifacts: ${artifacts.join(', ')}`);
  }
}

export function inspectPinnedPlanFiles(input: {
  systemDataDir: string;
  fleet: readonly FleetReceiptEntry[];
  systemDirectory: PinnedDirectory;
  persistenceDirectory: PinnedDirectory;
  existingDestinationDirectories: Map<string, PinnedDirectory>;
}): PinnedPlanFile[] {
  return [...PER_COMPANION_OWNER_FILES].map((ownerFile): PinnedPlanFile => {
    const sourcePath = join(input.systemDataDir, ownerFile);
    if (!pinnedLeafExists(input.systemDirectory, ownerFile)) {
      return { ownerFile, sourcePath, status: 'absent', destinations: [] };
    }
    const source = inspectPinnedRegularFile(
      input.systemDirectory,
      ownerFile,
      `${ownerFile} migration source`,
    );
    assertExactLinkCount(source, 1, `${ownerFile} migration source`);
    validatePinnedMigrationOwner(
      input.systemDirectory,
      ownerFile,
      `${ownerFile} migration source`,
    );
    const destinations = input.fleet.map((entry): SystemOwnerFleetMigrationDestinationPlan => {
      const destinationPath = join(entry.companionDataDir, ownerFile);
      const relativePath = relativeDirectoryPath(
        input.persistenceDirectory,
        entry.companionDataDir,
        `${ownerFile} migration destination`,
      );
      const directory = pinRelativeDirectory(
        input.persistenceDirectory,
        relativePath,
        `${ownerFile} migration destination directory`,
        { allowMissing: true },
      );
      if (!directory) {
        throw new Error(
          `Companion ${entry.companionId} migration destination directory is missing: ${entry.companionDataDir}`,
        );
      }
      const prior = input.existingDestinationDirectories.get(entry.companionId);
      if (prior) {
        closePinnedDirectory(directory);
      } else {
        const unknownArtifacts = migrationArtifactNames(directory);
        if (unknownArtifacts.length > 0) {
          closePinnedDirectory(directory);
          throw new Error(
            `Pre-existing migration-owned staging artifacts conflict for companion ${entry.companionId}: ${unknownArtifacts.join(', ')}`,
          );
        }
        input.existingDestinationDirectories.set(entry.companionId, directory);
      }
      const pinnedDirectory = prior ?? directory;
      if (!pinnedLeafExists(pinnedDirectory, ownerFile)) {
        return { ...entry, destinationPath, status: 'missing' };
      }
      const existing = inspectPinnedRegularFile(
        pinnedDirectory,
        ownerFile,
        `${ownerFile} migration destination`,
      );
      return { ...entry, destinationPath, status: 'conflict', existingSha256: existing.sha256 };
    });
    return {
      ownerFile,
      sourcePath,
      status: destinations.some(destination => destination.status === 'conflict') ? 'conflict' : 'ready',
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      sourceIdentity: { device: source.device, inode: source.inode },
      destinations,
    };
  });
}
