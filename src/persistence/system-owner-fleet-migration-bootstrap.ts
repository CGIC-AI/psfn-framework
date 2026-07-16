import {
  assertFilesystemIdentity,
  closePinnedDirectory,
  listPinnedDirectoryNames,
  pinRelativeDirectory,
  pinnedLeafExists,
  relativeDirectoryPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  destinationPinKey,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import {
  quarantineDirectoryName,
  stagingDirectoryName,
  type FleetReceiptEntry,
  type SystemOwnerFleetMigrationOptions,
  type SystemOwnerFleetMigrationReceipt,
} from './system-owner-fleet-migration-receipt.js';

export interface PreflightDestinationPins {
  destinationDirectory: PinnedDirectory;
  stagingDirectory?: PinnedDirectory;
}

export interface PreflightMigrationDirectories {
  destinationPins: ReadonlyMap<string, PreflightDestinationPins>;
  quarantineDirectory?: PinnedDirectory;
}

export interface InitializedMigrationDirectories<T> {
  destinationPins: Map<string, DestinationPins>;
  quarantineDirectory: PinnedDirectory;
  preflightResult: T;
}

function firstOwnerFile(receipt: SystemOwnerFleetMigrationReceipt): string {
  const ownerFile = receipt.files[0]?.ownerFile;
  if (!ownerFile) throw new Error('System-owner fleet migration bootstrap has no owner files');
  return ownerFile;
}

function requireEmptyUnboundDirectory(directory: PinnedDirectory, label: string): void {
  const entries = listPinnedDirectoryNames(directory);
  if (entries.length > 0) {
    throw new Error(`${label} existed before its filesystem identity was bound and is not empty`);
  }
}

function setStagingIdentity(
  receipt: SystemOwnerFleetMigrationReceipt,
  companionId: string,
  directory: PinnedDirectory,
): void {
  for (const file of receipt.files) {
    const destination = file.destinations.find(entry => entry.companionId === companionId);
    if (!destination) {
      throw new Error(`Receipt is missing destination ${companionId} for ${file.ownerFile}`);
    }
    destination.stagingDirectoryIdentity = directory.identity;
  }
}

function expectedStagingIdentity(
  receipt: SystemOwnerFleetMigrationReceipt,
  companionId: string,
): FilesystemIdentity | undefined {
  const identities = receipt.files
    .map(file => file.destinations.find(entry => entry.companionId === companionId)?.stagingDirectoryIdentity);
  const expected = identities[0];
  if (identities.some(identity => JSON.stringify(identity) !== JSON.stringify(expected))) {
    throw new Error(`Receipt has inconsistent staging identities for companion ${companionId}`);
  }
  return expected;
}

function expectedDestinationIdentity(
  receipt: SystemOwnerFleetMigrationReceipt,
  companionId: string,
): FilesystemIdentity {
  const identities = receipt.files.map(file => (
    file.destinations.find(entry => entry.companionId === companionId)?.companionDataDirIdentity
  ));
  const expected = identities[0];
  if (!expected || identities.some(identity => JSON.stringify(identity) !== JSON.stringify(expected))) {
    throw new Error(`Receipt has inconsistent destination identities for companion ${companionId}`);
  }
  return expected;
}

export function initializeMigrationDirectories<T>(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  receiptDirectory: PinnedDirectory;
  persistenceDirectory: PinnedDirectory;
  fleet: readonly FleetReceiptEntry[];
  plannedDestinationDirectories: Map<string, PinnedDirectory>;
  persistReceipt: () => void;
  preflight: (directories: PreflightMigrationDirectories) => T;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): InitializedMigrationDirectories<T> {
  const { receipt } = input;
  const ownerFile = firstOwnerFile(receipt);
  const quarantineName = quarantineDirectoryName(receipt.operationId);
  const stagingName = stagingDirectoryName(receipt.operationId);
  const destinationDirectories = new Map<string, PinnedDirectory>();
  const stagingDirectories = new Map<string, PinnedDirectory>();
  let quarantineDirectory: PinnedDirectory | undefined;
  try {
    // Pin and validate every receipt-bound root before creating or binding any
    // migration directory. These descriptors remain open through preflight and
    // all subsequent mutation, so same-path replacements cannot redirect work.
    for (const entry of input.fleet) {
      const plannedDirectory = input.plannedDestinationDirectories.get(entry.companionId);
      const label = `Companion ${entry.companionId} migration destination`;
      let destinationDirectory: PinnedDirectory;
      if (plannedDirectory) {
        destinationDirectory = plannedDirectory;
        input.plannedDestinationDirectories.delete(entry.companionId);
      } else {
        const relativePath = relativeDirectoryPath(
          input.persistenceDirectory,
          entry.companionDataDir,
          label,
        );
        const pinned = pinRelativeDirectory(
          input.persistenceDirectory,
          relativePath,
          `${label} directory`,
        );
        if (!pinned) throw new Error(`${label} directory is missing`);
        destinationDirectory = pinned;
      }
      assertFilesystemIdentity(
        destinationDirectory.identity,
        expectedDestinationIdentity(receipt, entry.companionId),
        `${label} directory`,
      );
      destinationDirectories.set(destinationPinKey(entry.companionId), destinationDirectory);
    }

    const quarantineExists = pinnedLeafExists(input.receiptDirectory, quarantineName);
    if (quarantineExists) {
      quarantineDirectory = pinRelativeDirectory(
        input.receiptDirectory,
        quarantineName,
        'System-owner migration quarantine directory',
      );
      if (!quarantineDirectory) throw new Error('Unable to pin migration quarantine directory');
      if (receipt.quarantineDirectoryIdentity) {
        assertFilesystemIdentity(
          quarantineDirectory.identity,
          receipt.quarantineDirectoryIdentity,
          'System-owner fleet migration quarantine directory',
        );
      } else {
        if (receipt.directoryCreationIntent?.kind !== 'quarantine') {
          throw new Error('Unrecorded pending quarantine directory appeared without creation intent');
        }
        requireEmptyUnboundDirectory(quarantineDirectory, 'Receipt-owned quarantine directory');
      }
    } else if (receipt.quarantineDirectoryIdentity) {
      throw new Error('Receipt-owned migration quarantine directory disappeared');
    }

    for (const entry of input.fleet) {
      const key = destinationPinKey(entry.companionId);
      const destinationDirectory = destinationDirectories.get(key);
      if (!destinationDirectory) throw new Error(`Missing pinned destination for ${entry.companionId}`);
      const expectedIdentity = expectedStagingIdentity(receipt, entry.companionId);
      if (!pinnedLeafExists(destinationDirectory, stagingName)) {
        if (expectedIdentity) {
          throw new Error(`Receipt-owned migration staging directory disappeared: ${entry.companionDataDir}`);
        }
        continue;
      }
      const stagingDirectory = pinRelativeDirectory(
        destinationDirectory,
        stagingName,
        `Companion ${entry.companionId} migration destination staging directory`,
      );
      if (!stagingDirectory) throw new Error(`Unable to pin migration staging for ${entry.companionId}`);
      stagingDirectories.set(key, stagingDirectory);
      if (expectedIdentity) {
        assertFilesystemIdentity(
          stagingDirectory.identity,
          expectedIdentity,
          `Companion ${entry.companionId} migration destination staging directory`,
        );
      } else {
        const intent = receipt.directoryCreationIntent;
        if (intent?.kind !== 'staging' || intent.companionId !== entry.companionId) {
          throw new Error(
            `Unrecorded pending staging directory appeared without creation intent: ${entry.companionDataDir}`,
          );
        }
        requireEmptyUnboundDirectory(
          stagingDirectory,
          `Companion ${entry.companionId} migration destination staging directory`,
        );
      }
    }

    const preflightPins = new Map<string, PreflightDestinationPins>();
    for (const [key, destinationDirectory] of destinationDirectories) {
      preflightPins.set(key, {
        destinationDirectory,
        ...(stagingDirectories.get(key)
          ? { stagingDirectory: stagingDirectories.get(key) }
          : {}),
      });
    }
    const preflightResult = input.preflight({
      destinationPins: preflightPins,
      quarantineDirectory,
    });

    if (!receipt.quarantineDirectoryIdentity) {
      if (receipt.directoryCreationIntent === undefined) {
        receipt.directoryCreationIntent = { kind: 'quarantine' };
        input.persistReceipt();
      }
      if (receipt.directoryCreationIntent.kind !== 'quarantine') {
        throw new Error('Receipt directory creation intent does not authorize quarantine initialization');
      }
      if (!quarantineDirectory) {
        quarantineDirectory = pinRelativeDirectory(
          input.receiptDirectory,
          quarantineName,
          'System-owner migration quarantine directory',
          { create: true, exclusiveLeafCreate: true, mode: 0o700 },
        );
        if (!quarantineDirectory) throw new Error('Unable to create migration quarantine directory');
        input.faultInjection?.({
          stage: 'after_quarantine_directory_create',
          ownerFile,
          path: receipt.quarantineDirectoryPath,
        });
      }
      receipt.quarantineDirectoryIdentity = quarantineDirectory.identity;
      delete receipt.directoryCreationIntent;
      input.persistReceipt();
      input.faultInjection?.({
        stage: 'after_quarantine_identity_receipt',
        ownerFile,
        path: receipt.quarantineDirectoryPath,
      });
    }
    if (!quarantineDirectory) throw new Error('Unable to pin migration quarantine directory');

    const destinationPins = new Map<string, DestinationPins>();
    for (const entry of input.fleet) {
      const key = destinationPinKey(entry.companionId);
      const destinationDirectory = destinationDirectories.get(key);
      if (!destinationDirectory) throw new Error(`Missing pinned destination for ${entry.companionId}`);
      let stagingDirectory = stagingDirectories.get(key);
      if (!expectedStagingIdentity(receipt, entry.companionId)) {
        if (receipt.directoryCreationIntent === undefined) {
          receipt.directoryCreationIntent = { kind: 'staging', companionId: entry.companionId };
          input.persistReceipt();
        }
        const intent = receipt.directoryCreationIntent;
        if (intent.kind !== 'staging' || intent.companionId !== entry.companionId) {
          throw new Error(`Receipt directory creation intent does not authorize staging for ${entry.companionId}`);
        }
        if (!stagingDirectory) {
          stagingDirectory = pinRelativeDirectory(
            destinationDirectory,
            stagingName,
            `Companion ${entry.companionId} migration destination staging directory`,
            { create: true, exclusiveLeafCreate: true, mode: 0o700 },
          );
          if (!stagingDirectory) throw new Error(`Unable to create migration staging for ${entry.companionId}`);
          stagingDirectories.set(key, stagingDirectory);
          input.faultInjection?.({
            stage: 'after_staging_directory_create',
            ownerFile,
            companionId: entry.companionId,
            path: stagingDirectory.logicalPath,
          });
        }
        setStagingIdentity(receipt, entry.companionId, stagingDirectory);
        delete receipt.directoryCreationIntent;
        input.persistReceipt();
        input.faultInjection?.({
          stage: 'after_staging_identity_receipt',
          ownerFile,
          companionId: entry.companionId,
          path: stagingDirectory.logicalPath,
        });
      }
      if (!stagingDirectory) throw new Error(`Unable to pin migration staging for ${entry.companionId}`);
      destinationPins.set(key, { destinationDirectory, stagingDirectory });
    }

    if (receipt.status === 'bootstrap') {
      receipt.status = 'in_progress';
      input.persistReceipt();
      input.faultInjection?.({
        stage: 'after_bootstrap_finalize',
        ownerFile,
        path: input.receiptDirectory.logicalPath,
      });
    }
    return { destinationPins, quarantineDirectory, preflightResult };
  } catch (error) {
    for (const directory of stagingDirectories.values()) closePinnedDirectory(directory);
    for (const directory of destinationDirectories.values()) closePinnedDirectory(directory);
    closePinnedDirectory(quarantineDirectory);
    throw error;
  }
}
