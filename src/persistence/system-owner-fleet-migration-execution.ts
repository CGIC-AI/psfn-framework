import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SYSTEM_OWNER_FLEET_MIGRATION_FILES } from './system-owner-fleet-migration-files.js';
import {
  assertExactLinkCount,
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
import {
  initializeMigrationDirectories,
  type PreflightMigrationDirectories,
} from './system-owner-fleet-migration-bootstrap.js';
import {
  assertSourceUnchanged,
  buildTemporaryPath,
  closeDestinationPins,
  destinationPinKey,
  publishDestination,
  retireSource,
  verifyCompletedDestinationEvidence,
  verifyDestination,
  verifyQuarantinedSource,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import {
  assertNoUnknownMigrationArtifacts,
  inspectPinnedPlanFiles,
} from './system-owner-fleet-migration-planning.js';
import { validatePinnedMigrationOwner } from './system-owner-fleet-owner-validation.js';
import {
  supersedeUnboundTemporary,
  validateRecordedArtifacts,
} from './system-owner-fleet-migration-recovery.js';
import {
  assertMigrationArtifactId,
  assertReceiptContents,
  assertReceiptIdentity,
  assertReceiptPinnedIdentities,
  assertReceiptRootIdentities,
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
  type CurrentOwnerReceiptEntry,
  type FileReceiptEntry,
} from './system-owner-fleet-migration-receipt.js';

type CurrentOwnerObservation = Omit<CurrentOwnerReceiptEntry, 'observedAt'>;

function observationKey(ownerFile: string, companionId: string): string {
  return `${ownerFile}\u0000${companionId}`;
}

function verifyRetiredFileEvidence(input: {
  file: FileReceiptEntry;
  systemDirectory: PinnedDirectory;
  quarantineDirectory: PinnedDirectory;
  destinations: ReadonlyMap<string, DestinationPins>;
}): Map<string, CurrentOwnerObservation> {
  const { file } = input;
  if (pinnedLeafExists(input.systemDirectory, file.ownerFile)) {
    throw new Error(`Retired migration source reappeared: ${file.sourcePath}`);
  }
  verifyQuarantinedSource(file, input.quarantineDirectory);
  const observations = new Map<string, CurrentOwnerObservation>();
  for (const destination of file.destinations) {
    if (destination.status !== 'verified') {
      throw new Error(
        `Source was retired before destination verification: ${destination.destinationPath}`,
      );
    }
    const pins = input.destinations.get(destinationPinKey(destination.companionId));
    if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
    const evidence = verifyCompletedDestinationEvidence(file, destination, pins);
    const current = validatePinnedMigrationOwner(
      pins.destinationDirectory,
      file.ownerFile,
      `${file.ownerFile} current receipt-bound owner`,
    );
    assertFilesystemIdentity(
      current,
      evidence.currentOwner,
      `${file.ownerFile} current receipt-bound owner`,
    );
    assertExactLinkCount(
      current,
      evidence.expectedCurrentLinkCount,
      `${file.ownerFile} current receipt-bound owner`,
    );
    observations.set(observationKey(file.ownerFile, destination.companionId), {
      bytes: current.bytes,
      sha256: current.sha256,
      identity: { device: current.device, inode: current.inode },
      provenance: 'canonical-owner-after-verified-source-retirement',
    });
  }
  return observations;
}

function preflightRecoveryState(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  systemDirectory: PinnedDirectory;
  quarantineDirectory: PinnedDirectory;
  destinations: ReadonlyMap<string, DestinationPins>;
}): Map<string, CurrentOwnerObservation> {
  const observations = new Map<string, CurrentOwnerObservation>();
  for (const file of input.receipt.files) {
    if (pinnedLeafExists(input.systemDirectory, file.ownerFile)) {
      if (file.status === 'retired') {
        throw new Error(`Retired migration source reappeared: ${file.sourcePath}`);
      }
      assertSourceUnchanged(file, input.systemDirectory);
      validatePinnedMigrationOwner(
        input.systemDirectory,
        file.ownerFile,
        `${file.ownerFile} migration source`,
      );
      if (pinnedLeafExists(input.quarantineDirectory, basename(file.quarantinePath))) {
        throw new Error(
          `Migration source and quarantine both exist for ${file.ownerFile}; refusing recovery`,
        );
      }
      for (const destination of file.destinations) {
        const pins = input.destinations.get(destinationPinKey(destination.companionId));
        if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
        if (destination.status === 'verified') {
          verifyDestination(file, destination, pins);
        } else if (pinnedLeafExists(pins.destinationDirectory, file.ownerFile)) {
          if (!destination.temporaryIdentity) {
            throw new Error(`Unrecorded pending destination appeared: ${destination.destinationPath}`);
          }
          verifyDestination(file, destination, pins);
        }
      }
      continue;
    }
    const fileObservations = verifyRetiredFileEvidence({
      file,
      systemDirectory: input.systemDirectory,
      quarantineDirectory: input.quarantineDirectory,
      destinations: input.destinations,
    });
    for (const [key, observation] of fileObservations) {
      observations.set(key, observation);
    }
  }
  return observations;
}

function requireInitializedPreflightDirectories(
  directories: PreflightMigrationDirectories,
): {
  quarantineDirectory: PinnedDirectory;
  destinations: Map<string, DestinationPins>;
} {
  if (!directories.quarantineDirectory) {
    throw new Error('Receipt-owned migration quarantine directory is missing');
  }
  const destinations = new Map<string, DestinationPins>();
  for (const [key, pins] of directories.destinationPins) {
    if (!pins.stagingDirectory) {
      throw new Error(`Receipt-owned migration staging directory is missing for ${key}`);
    }
    destinations.set(key, {
      destinationDirectory: pins.destinationDirectory,
      stagingDirectory: pins.stagingDirectory,
    });
  }
  return { quarantineDirectory: directories.quarantineDirectory, destinations };
}

function preflightBootstrapReceipt(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  systemDirectory: PinnedDirectory;
  directories: PreflightMigrationDirectories;
}): Map<string, CurrentOwnerObservation> {
  for (const file of input.receipt.files) {
    assertSourceUnchanged(file, input.systemDirectory);
    validatePinnedMigrationOwner(
      input.systemDirectory,
      file.ownerFile,
      `${file.ownerFile} migration source`,
    );
    if (input.directories.quarantineDirectory
      && pinnedLeafExists(
        input.directories.quarantineDirectory,
        basename(file.quarantinePath),
      )) {
      throw new Error(`Unrecorded pending quarantine artifact appeared: ${file.quarantinePath}`);
    }
    for (const destination of file.destinations) {
      const pins = input.directories.destinationPins.get(
        destinationPinKey(destination.companionId),
      );
      if (!pins) throw new Error(`Missing pinned destination for ${destination.companionId}`);
      if (pinnedLeafExists(pins.destinationDirectory, file.ownerFile)) {
        throw new Error(`Unrecorded pending destination appeared: ${destination.destinationPath}`);
      }
    }
  }
  return new Map();
}

function applyCurrentOwnerObservations(input: {
  file: FileReceiptEntry;
  observations: ReadonlyMap<string, CurrentOwnerObservation>;
  observedAt: string;
}): boolean {
  let changed = false;
  for (const destination of input.file.destinations) {
    const observation = input.observations.get(
      observationKey(input.file.ownerFile, destination.companionId),
    );
    if (!observation) {
      throw new Error(`Missing current-owner observation for ${destination.destinationPath}`);
    }
    const current = destination.currentOwner;
    if (current
      && current.bytes === observation.bytes
      && current.sha256 === observation.sha256
      && current.identity.device === observation.identity.device
      && current.identity.inode === observation.identity.inode) {
      continue;
    }
    destination.currentOwner = { ...observation, observedAt: input.observedAt };
    changed = true;
  }
  return changed;
}

function assertNoUntrackedOwnerFiles(
  receipt: SystemOwnerFleetMigrationReceipt,
  systemDirectory: PinnedDirectory,
): void {
  for (const ownerFile of SYSTEM_OWNER_FLEET_MIGRATION_FILES) {
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
      assertReceiptRootIdentities({
        receipt,
        systemDataDir: systemDirectory,
        receiptDirectory,
      });
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
          assertExactLinkCount(source, 1, `${file.ownerFile} migration source`);
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
    assertReceiptContents(receipt, systemDataDir, fleet);
    const initialized = initializeMigrationDirectories({
      receipt,
      receiptDirectory,
      persistenceDirectory,
      fleet,
      plannedDestinationDirectories,
      persistReceipt,
      preflight: (directories) => {
        validateRecordedArtifacts({
          receipt,
          receiptDirectory: receiptDirectory!,
          quarantineDirectory: directories.quarantineDirectory,
          destinationPins: directories.destinationPins,
        });
        assertNoUntrackedOwnerFiles(receipt, systemDirectory);
        if (receipt.status === 'bootstrap') {
          return preflightBootstrapReceipt({ receipt, systemDirectory, directories });
        }
        const pinned = requireInitializedPreflightDirectories(directories);
        return preflightRecoveryState({
          receipt,
          systemDirectory,
          quarantineDirectory: pinned.quarantineDirectory,
          destinations: pinned.destinations,
        });
      },
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
    const recoveryObservations = initialized.preflightResult;

    if (receipt.status === 'completed') {
      let receiptChanged = false;
      const observedAt = now().toISOString();
      for (const file of receipt.files) {
        receiptChanged = applyCurrentOwnerObservations({
          file,
          observations: recoveryObservations,
          observedAt,
        }) || receiptChanged;
      }
      if (receiptChanged) persistReceipt();
      return {
        status: 'already_completed',
        receiptPath: path,
        migratedOwnerFiles: receipt.files.map(file => file.ownerFile),
      };
    }

    for (const file of receipt.files) {
      if (file.status === 'retired') {
        if (applyCurrentOwnerObservations({
          file,
          observations: recoveryObservations,
          observedAt: now().toISOString(),
        })) persistReceipt();
        continue;
      }

      const sourceIsLive = pinnedLeafExists(systemDirectory, file.ownerFile);
      if (sourceIsLive) {
        assertSourceUnchanged(file, systemDirectory);
      }
      if (sourceIsLive) {
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
      } else {
        retireSource({
          file,
          systemDirectory,
          quarantineDirectory,
          faultInjection: options.faultInjection,
        });
      }
      const retiredObservations = verifyRetiredFileEvidence({
        file,
        systemDirectory,
        quarantineDirectory,
        destinations: destinationPins,
      });
      applyCurrentOwnerObservations({
        file,
        observations: retiredObservations,
        observedAt: now().toISOString(),
      });
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
