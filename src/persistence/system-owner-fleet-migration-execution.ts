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
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import { initializeMigrationDirectories } from './system-owner-fleet-migration-bootstrap.js';
import {
  assertSourceUnchanged,
  buildTemporaryPath,
  closeDestinationPins,
  destinationPinKey,
  publishDestination,
  retireSource,
  verifyDestination,
  verifyQuarantinedSource,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import {
  assertNoUnknownMigrationArtifacts,
  ensureDestinationDirectories,
  inspectPinnedPlanFiles,
} from './system-owner-fleet-migration-planning.js';
import {
  supersedeUnboundTemporary,
  validateRecordedArtifacts,
} from './system-owner-fleet-migration-recovery.js';
import {
  assertMigrationArtifactId,
  assertReceiptContents,
  assertReceiptIdentity,
  assertReceiptPinnedIdentities,
  fleetEntries,
  loadReceipt,
  quarantineDirectoryName,
  receiptPath,
  requireExpectedDigests,
  stagingDirectoryName,
  writeReceipt,
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

function assertNoUntrackedOwnerFiles(
  receipt: SystemOwnerFleetMigrationReceipt,
  systemDirectory: PinnedDirectory,
): void {
  for (const ownerFile of PER_COMPANION_OWNER_FILES) {
    if (!receipt.files.some(file => file.ownerFile === ownerFile)
      && pinnedLeafExists(systemDirectory, ownerFile)) {
      throw new Error(`Untracked system-root per-companion owner file appeared after receipt creation: ${ownerFile}`);
    }
  }
}

function firstReceiptOwnerFile(receipt: SystemOwnerFleetMigrationReceipt): string {
  const ownerFile = receipt.files[0]?.ownerFile;
  if (!ownerFile) throw new Error('System-owner fleet migration receipt has no owner files');
  return ownerFile;
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
      if (resolve(receipt.receiptDirectoryPath) !== receiptDirectory.logicalPath) {
        throw new Error('System-owner fleet migration receipt directory path is invalid');
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
      assertNoUnknownMigrationArtifacts(receiptDirectory, 'System-owner migration receipt directory');
      ensureDestinationDirectories({
        fleet,
        persistenceDirectory,
        plannedDestinationDirectories,
      });
      const operationId = temporaryId();
      assertMigrationArtifactId(operationId);
      const stagingName = stagingDirectoryName(operationId);
      const quarantineName = quarantineDirectoryName(operationId);
      const receiptDirectoryPath = receiptDirectory.logicalPath;
      const startedAt = now().toISOString();
      receipt = {
        schemaVersion: 4,
        migration: 'system-owner-fleet-reroot',
        status: 'bootstrap',
        operationId,
        systemDataDir,
        systemDataDirIdentity: systemDirectory.identity,
        receiptDirectoryPath,
        receiptDirectoryIdentity: receiptDirectory.identity,
        quarantineDirectoryPath: join(receiptDirectoryPath, quarantineName),
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
            throw new Error(`Source changed for ${file.ownerFile} while migration bootstrap was prepared`);
          }
          assertFilesystemIdentity(source, file.sourceIdentity, `${file.ownerFile} migration source`);
          const quarantineId = temporaryId();
          assertMigrationArtifactId(quarantineId);
          return {
            ownerFile: file.ownerFile,
            sourcePath: file.sourcePath,
            sourceSha256: file.sourceSha256,
            sourceBytes: file.sourceBytes,
            sourceIdentity: { device: source.device, inode: source.inode },
            quarantinePath: join(
              receiptDirectoryPath,
              quarantineName,
              `${file.ownerFile}.${quarantineId}.retired`,
            ),
            status: 'pending',
            destinations: file.destinations.map(destination => {
              const directory = plannedDestinationDirectories.get(destination.companionId);
              if (!directory) throw new Error(`Missing pinned destination for ${destination.companionId}`);
              const copyId = temporaryId();
              assertMigrationArtifactId(copyId);
              const stagingPath = join(directory.logicalPath, stagingName);
              return {
                companionId: destination.companionId,
                companionDataDir: destination.companionDataDir,
                companionDataDirIdentity: directory.identity,
                destinationPath: destination.destinationPath,
                stagingDirectoryPath: stagingPath,
                temporaryPath: buildTemporaryPath(
                  stagingPath,
                  destination.destinationPath,
                  `${operationId}-0-${copyId}`,
                ),
                copyGeneration: 0,
                supersededTemporaryFiles: [],
                sha256: file.sourceSha256,
                status: 'pending',
              };
            }),
          };
        }),
      };
      writeReceipt(path, receipt, receiptDirectory, true);
      options.faultInjection?.({
        stage: 'after_bootstrap_receipt',
        ownerFile: firstReceiptOwnerFile(receipt),
        path,
      });
    }

    const persistReceipt = (): void => {
      receipt.updatedAt = now().toISOString();
      writeReceipt(path, receipt, receiptDirectory);
    };
    const initialized = initializeMigrationDirectories({
      receipt,
      receiptDirectory,
      persistenceDirectory,
      fleet,
      plannedDestinationDirectories,
      persistReceipt,
      faultInjection: options.faultInjection,
    });
    quarantineDirectory = initialized.quarantineDirectory;
    for (const [key, pins] of initialized.destinationPins) destinationPins.set(key, pins);
    assertReceiptPinnedIdentities({
      receipt,
      systemDataDir: systemDirectory,
      receiptDirectory,
      quarantineDirectory,
    });
    assertReceiptContents(receipt, systemDataDir, fleet);
    validateRecordedArtifacts({
      receipt,
      receiptDirectory,
      quarantineDirectory,
      destinationPins,
    });
    assertNoUntrackedOwnerFiles(receipt, systemDirectory);

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
        supersedeUnboundTemporary({
          destination,
          pins,
          operationId: receipt.operationId,
          temporaryId,
          persistReceipt,
          faultInjection: options.faultInjection,
          ownerFile: file.ownerFile,
        });
        const publishedIdentities = publishDestination({
          file,
          destination,
          pins,
          systemDirectory,
          onTemporaryCreated: (identity) => {
            destination.temporaryIdentity = identity;
            persistReceipt();
          },
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
        destination.verifiedAt = now().toISOString();
        persistReceipt();
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
      file.retiredAt = now().toISOString();
      persistReceipt();
    }

    options.faultInjection?.({
      stage: 'before_final_receipt',
      ownerFile: firstReceiptOwnerFile(receipt),
      path,
    });
    receipt.status = 'completed';
    receipt.completedAt = now().toISOString();
    persistReceipt();
    options.faultInjection?.({
      stage: 'after_final_receipt',
      ownerFile: firstReceiptOwnerFile(receipt),
      path,
    });
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
