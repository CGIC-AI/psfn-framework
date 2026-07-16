import { basename } from 'node:path';
import {
  assertExactLinkCount,
  assertFilesystemIdentity,
  inspectPinnedRegularFile,
  listPinnedDirectoryNames,
  pinnedLeafExists,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  buildTemporaryPath,
  destinationPinKey,
  type DestinationPins,
} from './system-owner-fleet-migration-io.js';
import type { PreflightDestinationPins } from './system-owner-fleet-migration-bootstrap.js';
import {
  assertMigrationArtifactId,
  type DestinationReceiptEntry,
  type SystemOwnerFleetMigrationOptions,
  type SystemOwnerFleetMigrationReceipt,
} from './system-owner-fleet-migration-receipt.js';

export function validateRecordedArtifacts(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  receiptDirectory: PinnedDirectory;
  quarantineDirectory?: PinnedDirectory;
  destinationPins: ReadonlyMap<string, PreflightDestinationPins>;
}): void {
  const quarantineDirectoryLeaf = basename(input.receipt.quarantineDirectoryPath);
  const unknownReceiptArtifacts = listPinnedDirectoryNames(input.receiptDirectory)
    .filter(name => name.includes('.system-owner-fleet-reroot-')
      && name !== quarantineDirectoryLeaf);
  if (unknownReceiptArtifacts.length > 0) {
    throw new Error(`Receipt directory contains unknown migration artifacts: ${unknownReceiptArtifacts.join(', ')}`);
  }
  const allowedQuarantineLeaves = new Set(input.receipt.files.map(file => basename(file.quarantinePath)));
  if (input.quarantineDirectory) {
    const unknownQuarantine = listPinnedDirectoryNames(input.quarantineDirectory)
      .filter(name => !allowedQuarantineLeaves.has(name));
    if (unknownQuarantine.length > 0) {
      throw new Error(`Receipt-owned quarantine contains unknown artifacts: ${unknownQuarantine.join(', ')}`);
    }
  }
  for (const entry of input.receipt.fleet) {
    const pins = input.destinationPins.get(destinationPinKey(entry.companionId));
    if (!pins) throw new Error(`Missing pinned destination for ${entry.companionId}`);
    if (!pins.stagingDirectory) continue;
    const destinations = input.receipt.files.map(file => {
      const destination = file.destinations.find(candidate => candidate.companionId === entry.companionId);
      if (!destination) throw new Error(`Receipt is missing destination ${entry.companionId}`);
      return destination;
    });
    const allowedLeaves = new Set(destinations.flatMap(destination => [
      basename(destination.temporaryPath),
      ...destination.supersededTemporaryFiles.map(file => basename(file.path)),
    ]));
    const unknown = listPinnedDirectoryNames(pins.stagingDirectory)
      .filter(name => !allowedLeaves.has(name));
    if (unknown.length > 0) {
      throw new Error(`Receipt-owned staging directory contains unknown artifacts: ${unknown.join(', ')}`);
    }
    for (const destination of destinations) {
      const temporaryLeaf = basename(destination.temporaryPath);
      if (pinnedLeafExists(pins.stagingDirectory, temporaryLeaf)) {
        const current = inspectPinnedRegularFile(
          pins.stagingDirectory,
          temporaryLeaf,
          'Current migration temporary',
          { fsync: true },
        );
        if (destination.temporaryIdentity) {
          assertFilesystemIdentity(
            current,
            destination.temporaryIdentity,
            'Current migration temporary',
          );
        }
        if (!pinnedLeafExists(
          pins.destinationDirectory,
          basename(destination.destinationPath),
        )) {
          assertExactLinkCount(current, 1, 'Current migration temporary');
        }
      } else if (destination.temporaryIdentity) {
        throw new Error(`Receipt-owned migration temporary disappeared: ${destination.temporaryPath}`);
      }
      for (const superseded of destination.supersededTemporaryFiles) {
        const inspected = inspectPinnedRegularFile(
          pins.stagingDirectory,
          basename(superseded.path),
          'Superseded migration temporary',
          { fsync: true },
        );
        assertFilesystemIdentity(inspected, superseded.identity, 'Superseded migration temporary');
        assertExactLinkCount(inspected, 1, 'Superseded migration temporary');
        if (inspected.bytes !== superseded.bytes || inspected.sha256 !== superseded.sha256) {
          throw new Error(`Superseded migration temporary changed: ${superseded.path}`);
        }
      }
    }
  }
}

export function supersedeUnboundTemporary(input: {
  destination: DestinationReceiptEntry;
  pins: DestinationPins;
  operationId: string;
  temporaryId: () => string;
  persistReceipt: () => void;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
  ownerFile: string;
}): void {
  if (input.destination.temporaryIdentity
    || !pinnedLeafExists(input.pins.stagingDirectory, basename(input.destination.temporaryPath))) {
    return;
  }
  const superseded = inspectPinnedRegularFile(
    input.pins.stagingDirectory,
    basename(input.destination.temporaryPath),
    `${input.ownerFile} unbound migration temporary`,
    { fsync: true },
  );
  input.destination.supersededTemporaryFiles.push({
    path: input.destination.temporaryPath,
    identity: { device: superseded.device, inode: superseded.inode },
    bytes: superseded.bytes,
    sha256: superseded.sha256,
  });
  input.destination.copyGeneration += 1;
  const nextId = input.temporaryId();
  assertMigrationArtifactId(nextId);
  input.destination.temporaryPath = buildTemporaryPath(
    input.pins.stagingDirectory.logicalPath,
    input.destination.destinationPath,
    `${input.operationId}-${input.destination.copyGeneration}-${nextId}`,
  );
  input.persistReceipt();
  input.faultInjection?.({
    stage: 'after_temporary_superseded_receipt',
    ownerFile: input.ownerFile,
    companionId: input.destination.companionId,
    path: input.destination.temporaryPath,
  });
}
