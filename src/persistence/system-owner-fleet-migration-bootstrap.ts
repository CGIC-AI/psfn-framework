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
  closeDestinationPins,
  destinationPinKey,
  openStagingDirectoryPins,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import {
  quarantineDirectoryName,
  stagingDirectoryName,
  type FleetReceiptEntry,
  type SystemOwnerFleetMigrationOptions,
  type SystemOwnerFleetMigrationReceipt,
} from './system-owner-fleet-migration-receipt.js';

export interface InitializedMigrationDirectories {
  destinationPins: Map<string, DestinationPins>;
  quarantineDirectory: PinnedDirectory;
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

export function initializeMigrationDirectories(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  receiptDirectory: PinnedDirectory;
  persistenceDirectory: PinnedDirectory;
  fleet: readonly FleetReceiptEntry[];
  plannedDestinationDirectories: Map<string, PinnedDirectory>;
  persistReceipt: () => void;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): InitializedMigrationDirectories {
  const { receipt } = input;
  const ownerFile = firstOwnerFile(receipt);
  const quarantineName = quarantineDirectoryName(receipt.operationId);
  const quarantineExisted = pinnedLeafExists(input.receiptDirectory, quarantineName);
  const quarantineDirectory = pinRelativeDirectory(
    input.receiptDirectory,
    quarantineName,
    'System-owner migration quarantine directory',
    { create: receipt.quarantineDirectoryIdentity === undefined, mode: 0o700 },
  );
  if (!quarantineDirectory) throw new Error('Unable to pin migration quarantine directory');
  const destinationPins = new Map<string, DestinationPins>();
  try {
    if (receipt.quarantineDirectoryIdentity) {
      assertFilesystemIdentity(
        quarantineDirectory.identity,
        receipt.quarantineDirectoryIdentity,
        'System-owner fleet migration quarantine directory',
      );
    } else {
      if (quarantineExisted) {
        requireEmptyUnboundDirectory(quarantineDirectory, 'Receipt-owned quarantine directory');
      }
      input.faultInjection?.({
        stage: 'after_quarantine_directory_create',
        ownerFile,
        path: receipt.quarantineDirectoryPath,
      });
      receipt.quarantineDirectoryIdentity = quarantineDirectory.identity;
      input.persistReceipt();
      input.faultInjection?.({
        stage: 'after_quarantine_identity_receipt',
        ownerFile,
        path: receipt.quarantineDirectoryPath,
      });
    }

    const stagingName = stagingDirectoryName(receipt.operationId);
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
      const expectedIdentity = expectedStagingIdentity(receipt, entry.companionId);
      try {
        const stagingExisted = pinnedLeafExists(destinationDirectory, stagingName);
        const pins = openStagingDirectoryPins({
          destinationDirectory,
          label,
          stagingDirectoryName: stagingName,
          create: expectedIdentity === undefined,
          exclusiveStagingCreate: false,
        });
        destinationPins.set(destinationPinKey(entry.companionId), pins);
        if (expectedIdentity) {
          assertFilesystemIdentity(
            pins.stagingDirectory.identity,
            expectedIdentity,
            `${label} staging directory`,
          );
        } else {
          if (stagingExisted) {
            requireEmptyUnboundDirectory(pins.stagingDirectory, `${label} staging directory`);
          }
          input.faultInjection?.({
            stage: 'after_staging_directory_create',
            ownerFile,
            companionId: entry.companionId,
            path: pins.stagingDirectory.logicalPath,
          });
          setStagingIdentity(receipt, entry.companionId, pins.stagingDirectory);
          input.persistReceipt();
          input.faultInjection?.({
            stage: 'after_staging_identity_receipt',
            ownerFile,
            companionId: entry.companionId,
            path: pins.stagingDirectory.logicalPath,
          });
        }
      } catch (error) {
        if (!destinationPins.has(destinationPinKey(entry.companionId))) {
          closePinnedDirectory(destinationDirectory);
        }
        throw error;
      }
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
    return { destinationPins, quarantineDirectory };
  } catch (error) {
    closeDestinationPins(destinationPins);
    closePinnedDirectory(quarantineDirectory);
    throw error;
  }
}
