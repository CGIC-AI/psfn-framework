import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import {
  assertFilesystemIdentity,
  closePinnedDirectory,
  inspectPinnedRegularFile,
  pinAbsoluteDirectory,
  pinRelativeDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  relativeDirectoryPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  assertSourceUnchanged,
  buildTemporaryPath,
  closeDestinationPins,
  destinationPinKey,
  openDestinationPins,
  openStagingDirectoryPins,
  publishDestination,
  retireSource,
  verifyDestination,
  verifyQuarantinedSource,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import {
  MIGRATION_QUARANTINE_DIRECTORY,
  MIGRATION_STAGING_DIRECTORY,
  assertReceiptContents,
  assertReceiptIdentity,
  assertReceiptPinnedIdentities,
  fleetEntries,
  loadReceipt,
  receiptPath,
  requireExpectedDigests,
  writeReceipt,
  type FleetReceiptEntry,
  type SystemOwnerFleetMigrationDestinationPlan,
  type SystemOwnerFleetMigrationFilePlan,
  type SystemOwnerFleetMigrationOptions,
  type SystemOwnerFleetMigrationReceipt,
  type SystemOwnerFleetMigrationResult,
} from './system-owner-fleet-migration-receipt.js';

function verifyCompletedReceipt(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  systemDirectory: PinnedDirectory;
  quarantineDirectory: PinnedDirectory;
  destinations: ReadonlyMap<string, DestinationPins>;
}): void {
  for (const file of input.receipt.files) {
    if (file.status !== 'retired' || pinnedLeafExists(input.systemDirectory, file.ownerFile)) {
      throw new Error(`Completed migration receipt has a live or unretired source: ${file.sourcePath}`);
    }
    verifyQuarantinedSource(file, input.quarantineDirectory);
    for (const destination of file.destinations) {
      if (destination.status !== 'verified') {
        throw new Error(`Completed migration receipt has an unverified destination: ${destination.destinationPath}`);
      }
      const pins = input.destinations.get(destinationPinKey(destination.companionId));
      if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
      verifyDestination(file, destination, pins);
    }
  }
}

type PinnedPlanFile = SystemOwnerFleetMigrationFilePlan & {
  sourceIdentity?: FilesystemIdentity;
};

function inspectPinnedPlanFiles(input: {
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
      if (!directory) return { ...entry, destinationPath, status: 'missing' };
      const prior = input.existingDestinationDirectories.get(entry.companionId);
      if (prior) {
        closePinnedDirectory(directory);
      } else {
        if (pinnedLeafExists(directory, MIGRATION_STAGING_DIRECTORY)) {
          closePinnedDirectory(directory);
          throw new Error(
            `Pre-existing migration-owned staging directory conflicts for companion ${entry.companionId}`,
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

export function executeSystemOwnerFleetMigration(
  options: SystemOwnerFleetMigrationOptions,
): SystemOwnerFleetMigrationResult {
  const systemDataDir = resolve(options.systemDataDir);
  const fleet = fleetEntries(options.fleet);
  const path = receiptPath(systemDataDir);
  const now = options.now ?? (() => new Date());
  const temporaryId = options.temporaryId ?? randomUUID;
  const systemDirectory = pinAbsoluteDirectory(systemDataDir, 'System-owner migration system directory');
  const persistenceDirectory = pinAbsoluteDirectory(
    options.fleet.persistenceRoot,
    'System-owner migration persistence directory',
  );
  let receiptDirectory: PinnedDirectory | undefined;
  let quarantineDirectory: PinnedDirectory | undefined;
  const destinationPins = new Map<string, DestinationPins>();
  const plannedDestinationDirectories = new Map<string, PinnedDirectory>();
  try {
    receiptDirectory = pinRelativeDirectory(
      systemDirectory,
      'migrations',
      'System-owner migration receipt directory',
      { allowMissing: true },
    );
    const hasReceipt = receiptDirectory
      ? pinnedLeafExists(receiptDirectory, basename(path))
      : false;
    let receipt: SystemOwnerFleetMigrationReceipt;

    if (hasReceipt && receiptDirectory) {
      receipt = loadReceipt(path, pinnedLeafPath(receiptDirectory, basename(path)));
      assertReceiptIdentity(receipt, systemDataDir, fleet);
      assertReceiptContents(receipt, systemDataDir, fleet);
      requireExpectedDigests(receipt.files, options.expectedSourceDigests);
      if (resolve(receipt.receiptDirectoryPath) !== receiptDirectory.logicalPath
        || resolve(receipt.quarantineDirectoryPath)
          !== join(receiptDirectory.logicalPath, MIGRATION_QUARANTINE_DIRECTORY)) {
        throw new Error('System-owner fleet migration receipt directory paths are invalid');
      }
      quarantineDirectory = pinRelativeDirectory(
        receiptDirectory,
        MIGRATION_QUARANTINE_DIRECTORY,
        'System-owner migration quarantine directory',
      );
      if (!quarantineDirectory) throw new Error('System-owner migration quarantine directory is missing');
      assertReceiptPinnedIdentities({
        receipt,
        systemDataDir: systemDirectory,
        receiptDirectory,
        quarantineDirectory,
      });
      for (const entry of fleet) {
        destinationPins.set(destinationPinKey(entry.companionId), openDestinationPins({
          persistenceDirectory,
          companionDataDir: entry.companionDataDir,
          label: `Companion ${entry.companionId} migration destination`,
          create: false,
          exclusiveStagingCreate: false,
        }));
      }
      for (const file of receipt.files) {
        for (const destination of file.destinations) {
          const pins = destinationPins.get(destinationPinKey(destination.companionId));
          if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
          assertFilesystemIdentity(
            pins.destinationDirectory.identity,
            destination.companionDataDirIdentity,
            `${file.ownerFile} migration destination directory`,
          );
          assertFilesystemIdentity(
            pins.stagingDirectory.identity,
            destination.stagingDirectoryIdentity,
            `${file.ownerFile} migration staging directory`,
          );
        }
      }
      for (const ownerFile of PER_COMPANION_OWNER_FILES) {
        if (!receipt.files.some(file => file.ownerFile === ownerFile)
          && pinnedLeafExists(systemDirectory, ownerFile)) {
          throw new Error(`Untracked system-root per-companion owner file appeared after receipt creation: ${ownerFile}`);
        }
      }
      if (receipt.status === 'completed') {
        verifyCompletedReceipt({
          receipt,
          systemDirectory,
          quarantineDirectory,
          destinations: destinationPins,
        });
        return {
          status: 'already_completed',
          receiptPath: path,
          migratedOwnerFiles: receipt.files.map(file => file.ownerFile),
        };
      }
    } else {
      const planFiles = inspectPinnedPlanFiles({
        systemDataDir,
        fleet,
        systemDirectory,
        persistenceDirectory,
        existingDestinationDirectories: plannedDestinationDirectories,
      });
      const sourceCount = planFiles.filter(file => file.status !== 'absent').length;
      if (sourceCount === 0) {
        requireExpectedDigests([], options.expectedSourceDigests);
        return { status: 'not_needed', receiptPath: path, migratedOwnerFiles: [] };
      }
      const conflicts = planFiles
        .filter(file => file.status === 'conflict')
        .flatMap(file => file.destinations
          .filter(destination => destination.status === 'conflict')
          .map(destination => `${file.ownerFile}:${destination.destinationPath}`));
      if (conflicts.length > 0) {
        throw new Error(`Refusing system-owner fleet migration with destination conflicts: ${conflicts.join(', ')}`);
      }
      const sourceFiles = planFiles.filter((file): file is SystemOwnerFleetMigrationFilePlan & {
        status: 'ready'; sourceSha256: string; sourceBytes: number; sourceIdentity: FilesystemIdentity;
      } => file.status === 'ready');
      requireExpectedDigests(sourceFiles, options.expectedSourceDigests);

      if (!receiptDirectory) {
        receiptDirectory = pinRelativeDirectory(
          systemDirectory,
          'migrations',
          'System-owner migration receipt directory',
          { create: true, mode: 0o700 },
        );
      }
      if (!receiptDirectory) throw new Error('Unable to pin migration receipt directory');
      try {
        quarantineDirectory = pinRelativeDirectory(
          receiptDirectory,
          MIGRATION_QUARANTINE_DIRECTORY,
          'System-owner migration quarantine directory',
          { create: true, exclusiveLeafCreate: true, mode: 0o700 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Pre-existing migration-owned quarantine directory conflicts');
        }
        throw error;
      }
      if (!quarantineDirectory) throw new Error('Unable to pin migration quarantine directory');
      for (const entry of fleet) {
        const plannedDirectory = plannedDestinationDirectories.get(entry.companionId);
        const label = `Companion ${entry.companionId} migration destination`;
        if (plannedDirectory) {
          destinationPins.set(destinationPinKey(entry.companionId), openStagingDirectoryPins({
            destinationDirectory: plannedDirectory,
            label,
            create: true,
            exclusiveStagingCreate: true,
          }));
          plannedDestinationDirectories.delete(entry.companionId);
        } else {
          destinationPins.set(destinationPinKey(entry.companionId), openDestinationPins({
            persistenceDirectory,
            companionDataDir: entry.companionDataDir,
            label,
            create: true,
            exclusiveStagingCreate: true,
          }));
        }
      }

      const startedAt = now().toISOString();
      const quarantineDirectoryPath = quarantineDirectory.logicalPath;
      receipt = {
        schemaVersion: 3,
        migration: 'system-owner-fleet-reroot',
        status: 'in_progress',
        systemDataDir,
        systemDataDirIdentity: systemDirectory.identity,
        receiptDirectoryPath: receiptDirectory.logicalPath,
        receiptDirectoryIdentity: receiptDirectory.identity,
        quarantineDirectoryPath: quarantineDirectory.logicalPath,
        quarantineDirectoryIdentity: quarantineDirectory.identity,
        fleet,
        startedAt,
        updatedAt: startedAt,
        files: sourceFiles.map(file => {
          const source = inspectPinnedRegularFile(
            systemDirectory,
            file.ownerFile,
            `${file.ownerFile} migration source`,
          );
          if (source.sha256 !== file.sourceSha256 || source.bytes !== file.sourceBytes) {
            throw new Error(`Source changed for ${file.ownerFile} while migration directories were pinned`);
          }
          assertFilesystemIdentity(
            source,
            file.sourceIdentity,
            `${file.ownerFile} migration source`,
          );
          return {
            ownerFile: file.ownerFile,
            sourcePath: file.sourcePath,
            sourceSha256: file.sourceSha256,
            sourceBytes: file.sourceBytes,
            sourceIdentity: { device: source.device, inode: source.inode },
            quarantinePath: join(
              quarantineDirectoryPath,
              `${file.ownerFile}.${temporaryId()}.retired`,
            ),
            status: 'pending',
            destinations: file.destinations.map(destination => {
              const pins = destinationPins.get(destinationPinKey(destination.companionId));
              if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
              const temporaryPath = buildTemporaryPath(
                pins.stagingDirectory.logicalPath,
                destination.destinationPath,
                temporaryId(),
              );
              if (pinnedLeafExists(pins.stagingDirectory, basename(temporaryPath))) {
                throw new Error(`Pre-existing migration temporary path conflicts: ${temporaryPath}`);
              }
              return {
                companionId: destination.companionId,
                companionDataDir: destination.companionDataDir,
                companionDataDirIdentity: pins.destinationDirectory.identity,
                destinationPath: destination.destinationPath,
                stagingDirectoryPath: pins.stagingDirectory.logicalPath,
                stagingDirectoryIdentity: pins.stagingDirectory.identity,
                temporaryPath,
                sha256: file.sourceSha256,
                status: 'pending',
              };
            }),
          };
        }),
      };
      writeReceipt(path, receipt, receiptDirectory, true);
    }

    for (const file of receipt.files) {
      if (file.status === 'retired') {
        if (pinnedLeafExists(systemDirectory, file.ownerFile)) {
          throw new Error(`Retired migration source reappeared: ${file.sourcePath}`);
        }
        verifyQuarantinedSource(file, quarantineDirectory);
        for (const destination of file.destinations) {
          const pins = destinationPins.get(destinationPinKey(destination.companionId));
          if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
          verifyDestination(file, destination, pins);
        }
        continue;
      }

      if (pinnedLeafExists(systemDirectory, file.ownerFile)) {
        assertSourceUnchanged(file, systemDirectory);
      } else if (!pinnedLeafExists(quarantineDirectory, basename(file.quarantinePath))) {
        throw new Error(`Migration source disappeared outside quarantine: ${file.sourcePath}`);
      }
      for (const destination of file.destinations) {
        const pins = destinationPins.get(destinationPinKey(destination.companionId));
        if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
        if (destination.status === 'verified') {
          verifyDestination(file, destination, pins);
          continue;
        }
        assertSourceUnchanged(file, systemDirectory);
        const publishedIdentities = publishDestination({
          file,
          destination,
          pins,
          systemDirectory,
          faultInjection: options.faultInjection,
        });
        destination.destinationIdentity = publishedIdentities.destinationIdentity;
        destination.temporaryIdentity = publishedIdentities.temporaryIdentity;
        options.faultInjection?.({
          stage: 'before_receipt_update',
          ownerFile: file.ownerFile,
          companionId: destination.companionId,
          path: destination.destinationPath,
        });
        destination.status = 'verified';
        const verifiedAt = now().toISOString();
        destination.verifiedAt = verifiedAt;
        receipt.updatedAt = verifiedAt;
        writeReceipt(path, receipt, receiptDirectory);
        options.faultInjection?.({
          stage: 'after_receipt_update',
          ownerFile: file.ownerFile,
          companionId: destination.companionId,
          path: destination.destinationPath,
        });
        options.afterDestinationVerified?.({
          ownerFile: file.ownerFile,
          companionId: destination.companionId,
          destinationPath: destination.destinationPath,
        });
      }

      for (const destination of file.destinations) {
        const pins = destinationPins.get(destinationPinKey(destination.companionId));
        if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
        verifyDestination(file, destination, pins);
      }
      retireSource({
        file,
        systemDirectory,
        quarantineDirectory,
        faultInjection: options.faultInjection,
      });
      for (const destination of file.destinations) {
        const pins = destinationPins.get(destinationPinKey(destination.companionId));
        if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
        verifyDestination(file, destination, pins);
      }
      file.status = 'retired';
      const retiredAt = now().toISOString();
      file.retiredAt = retiredAt;
      receipt.updatedAt = retiredAt;
      writeReceipt(path, receipt, receiptDirectory);
    }

    receipt.status = 'completed';
    const completedAt = now().toISOString();
    receipt.completedAt = completedAt;
    receipt.updatedAt = completedAt;
    writeReceipt(path, receipt, receiptDirectory);
    return {
      status: 'migrated',
      receiptPath: path,
      migratedOwnerFiles: receipt.files.map(file => file.ownerFile),
    };
  } finally {
    for (const directory of plannedDestinationDirectories.values()) {
      closePinnedDirectory(directory);
    }
    closeDestinationPins(destinationPins);
    closePinnedDirectory(quarantineDirectory);
    closePinnedDirectory(receiptDirectory);
    closePinnedDirectory(persistenceDirectory);
    closePinnedDirectory(systemDirectory);
  }
}
