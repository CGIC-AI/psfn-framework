import { basename, join, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../system/config/companions-config.js';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import {
  closePinnedDirectory,
  inspectPinnedRegularFile,
  pinAbsoluteDirectory,
  pinRelativeDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  relativeDirectoryPath,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  assertReceiptContents,
  assertReceiptIdentity,
  fleetEntries,
  loadReceipt,
  receiptPath,
  type SystemOwnerFleetMigrationDestinationPlan,
  type SystemOwnerFleetMigrationFilePlan,
  type SystemOwnerFleetMigrationPlan,
} from './system-owner-fleet-migration-receipt.js';

export { executeSystemOwnerFleetMigration } from './system-owner-fleet-migration-execution.js';
export type {
  SystemOwnerFleetMigrationDestinationPlan,
  SystemOwnerFleetMigrationFilePlan,
  SystemOwnerFleetMigrationOptions,
  SystemOwnerFleetMigrationPlan,
  SystemOwnerFleetMigrationResult,
} from './system-owner-fleet-migration-receipt.js';

export function buildSystemOwnerFleetMigrationPlan(input: {
  systemDataDir: string;
  fleet: ResolvedCompanionsFleetConfig;
}): SystemOwnerFleetMigrationPlan {
  const systemDataDir = resolve(input.systemDataDir);
  const fleet = fleetEntries(input.fleet);
  const path = receiptPath(systemDataDir);
  const systemDirectory = pinAbsoluteDirectory(systemDataDir, 'System-owner migration system directory');
  const persistenceDirectory = pinAbsoluteDirectory(
    input.fleet.persistenceRoot,
    'System-owner migration persistence directory',
  );
  let migrationsDirectory: PinnedDirectory | undefined;
  try {
    migrationsDirectory = pinRelativeDirectory(
      systemDirectory,
      'migrations',
      'System-owner migration receipt directory',
      { allowMissing: true },
    );
    if (migrationsDirectory && pinnedLeafExists(migrationsDirectory, basename(path))) {
      const receipt = loadReceipt(path, pinnedLeafPath(migrationsDirectory, basename(path)));
      assertReceiptIdentity(receipt, systemDataDir, fleet);
      assertReceiptContents(receipt, systemDataDir, fleet);
      throw new Error(
        `A system-owner fleet migration receipt already exists at ${path}; rerun the apply command with its original digest approvals`,
      );
    }

    const files = [...PER_COMPANION_OWNER_FILES].map((ownerFile): SystemOwnerFleetMigrationFilePlan => {
      const sourcePath = join(systemDataDir, ownerFile);
      if (!pinnedLeafExists(systemDirectory, ownerFile)) {
        return { ownerFile, sourcePath, status: 'absent', destinations: [] };
      }
      const source = inspectPinnedRegularFile(
        systemDirectory,
        ownerFile,
        `${ownerFile} migration source`,
      );
      const destinations = fleet.map((entry): SystemOwnerFleetMigrationDestinationPlan => {
        const destinationPath = join(entry.companionDataDir, ownerFile);
        const destinationRelativePath = relativeDirectoryPath(
          persistenceDirectory,
          entry.companionDataDir,
          `${ownerFile} migration destination`,
        );
        const destinationDirectory = pinRelativeDirectory(
          persistenceDirectory,
          destinationRelativePath,
          `${ownerFile} migration destination directory`,
          { allowMissing: true },
        );
        if (!destinationDirectory) return { ...entry, destinationPath, status: 'missing' };
        try {
          if (!pinnedLeafExists(destinationDirectory, ownerFile)) {
            return { ...entry, destinationPath, status: 'missing' };
          }
          const existing = inspectPinnedRegularFile(
            destinationDirectory,
            ownerFile,
            `${ownerFile} migration destination`,
          );
          return {
            ...entry,
            destinationPath,
            status: 'conflict',
            existingSha256: existing.sha256,
          };
        } finally {
          closePinnedDirectory(destinationDirectory);
        }
      });
      return {
        ownerFile,
        sourcePath,
        status: destinations.some(destination => destination.status === 'conflict')
          ? 'conflict'
          : 'ready',
        sourceSha256: source.sha256,
        sourceBytes: source.bytes,
        destinations,
      };
    });
    const sourceCount = files.filter(file => file.status !== 'absent').length;
    const conflictCount = files.filter(file => file.status === 'conflict').length;
    return {
      receiptPath: path,
      systemDataDir,
      fleet,
      files,
      sourceCount,
      conflictCount,
      canApply: sourceCount > 0 && conflictCount === 0,
    };
  } finally {
    closePinnedDirectory(migrationsDirectory);
    closePinnedDirectory(persistenceDirectory);
    closePinnedDirectory(systemDirectory);
  }
}
