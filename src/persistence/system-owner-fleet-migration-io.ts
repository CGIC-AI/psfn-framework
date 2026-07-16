import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  assertFilesystemIdentity,
  closePinnedDirectory,
  filesystemIdentityForDescriptor,
  inspectPinnedRegularFile,
  pinRelativeDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  type DestinationReceiptEntry,
  type FileReceiptEntry,
  type SystemOwnerFleetMigrationOptions,
} from './system-owner-fleet-migration-receipt.js';

export interface DestinationPins {
  destinationDirectory: PinnedDirectory;
  stagingDirectory: PinnedDirectory;
}

export interface PublishedDestinationIdentities {
  destinationIdentity: FilesystemIdentity;
  temporaryIdentity: FilesystemIdentity;
}

function requireStagingDirectoryIdentity(destination: DestinationReceiptEntry): FilesystemIdentity {
  if (!destination.stagingDirectoryIdentity) {
    throw new Error(`Migration staging directory identity is not initialized: ${destination.stagingDirectoryPath}`);
  }
  return destination.stagingDirectoryIdentity;
}

export function buildTemporaryPath(
  stagingDirectoryPath: string,
  destinationPath: string,
  temporaryId: string,
): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(temporaryId)) {
    throw new Error('System-owner fleet migration temporary id is invalid');
  }
  return join(
    stagingDirectoryPath,
    `.${basename(destinationPath)}.system-owner-fleet-reroot-${temporaryId}.tmp`,
  );
}

function writeAllAt(descriptor: number, bytes: Buffer, start: number, end = bytes.length): void {
  let offset = start;
  while (offset < end) {
    const written = writeSync(descriptor, bytes, offset, end - offset, offset);
    if (written <= 0) throw new Error('Temporary owner-file copy made no write progress');
    offset += written;
  }
}

function copySourceToTemporary(input: {
  file: FileReceiptEntry;
  destination: DestinationReceiptEntry;
  systemDirectory: PinnedDirectory;
  stagingDirectory: PinnedDirectory;
  onTemporaryCreated: (identity: FilesystemIdentity) => void;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): void {
  const { file, destination } = input;
  const temporaryLeaf = basename(destination.temporaryPath);
  assertSourceUnchanged(file, input.systemDirectory);
  const sourceDescriptor = openSync(
    pinnedLeafPath(input.systemDirectory, file.ownerFile),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let temporaryDescriptor: number | null = null;
  try {
    assertFilesystemIdentity(
      filesystemIdentityForDescriptor(sourceDescriptor),
      file.sourceIdentity,
      `${file.ownerFile} migration source descriptor`,
    );
    const sourceBytes = readFileSync(sourceDescriptor);
    const temporaryOperationPath = pinnedLeafPath(input.stagingDirectory, temporaryLeaf);
    if (pinnedLeafExists(input.stagingDirectory, temporaryLeaf)) {
      if (!destination.temporaryIdentity) {
        throw new Error(`Unbound migration temporary requires durable supersession: ${destination.temporaryPath}`);
      }
      temporaryDescriptor = openSync(
        temporaryOperationPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      const stats = fstatSync(temporaryDescriptor);
      if (!stats.isFile()) {
        throw new Error(`Migration temporary must be a regular file: ${destination.temporaryPath}`);
      }
      assertFilesystemIdentity(
        filesystemIdentityForDescriptor(temporaryDescriptor),
        destination.temporaryIdentity,
        `${file.ownerFile} migration temporary`,
      );
    } else {
      if (destination.temporaryIdentity) {
        throw new Error(`Receipt-owned migration temporary disappeared: ${destination.temporaryPath}`);
      }
      temporaryDescriptor = openSync(
        temporaryOperationPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      input.faultInjection?.({
        stage: 'after_temporary_create',
        ownerFile: file.ownerFile,
        companionId: destination.companionId,
        path: destination.temporaryPath,
      });
      const identity = filesystemIdentityForDescriptor(temporaryDescriptor);
      fsyncSync(input.stagingDirectory.descriptor);
      input.onTemporaryCreated(identity);
      input.faultInjection?.({
        stage: 'after_temporary_identity_receipt',
        ownerFile: file.ownerFile,
        companionId: destination.companionId,
        path: destination.temporaryPath,
      });
    }
    const existingBytes = readFileSync(temporaryDescriptor);
    if (existingBytes.length > sourceBytes.length
      || !existingBytes.equals(sourceBytes.subarray(0, existingBytes.length))) {
      throw new Error(`Receipt-owned migration temporary is not an exact source prefix: ${destination.temporaryPath}`);
    }
    const split = sourceBytes.length > 1 ? Math.ceil(sourceBytes.length / 2) : sourceBytes.length;
    if (existingBytes.length < split) {
      writeAllAt(temporaryDescriptor, sourceBytes, existingBytes.length, split);
    }
    if (existingBytes.length <= split && split < sourceBytes.length) {
      input.faultInjection?.({
        stage: 'during_temporary_copy',
        ownerFile: file.ownerFile,
        companionId: destination.companionId,
        path: destination.temporaryPath,
      });
    }
    if (Math.max(existingBytes.length, split) < sourceBytes.length) {
      writeAllAt(temporaryDescriptor, sourceBytes, Math.max(existingBytes.length, split));
    }
    fsyncSync(temporaryDescriptor);
    input.faultInjection?.({
      stage: 'after_temporary_fsync',
      ownerFile: file.ownerFile,
      companionId: destination.companionId,
      path: destination.temporaryPath,
    });
  } finally {
    if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
    closeSync(sourceDescriptor);
  }
  assertSourceUnchanged(file, input.systemDirectory);
  const temporary = inspectPinnedRegularFile(
    input.stagingDirectory,
    temporaryLeaf,
    `${file.ownerFile} migration temporary`,
  );
  if (temporary.sha256 !== file.sourceSha256 || temporary.bytes !== file.sourceBytes) {
    throw new Error(`Temporary copy verification failed for ${file.ownerFile}`);
  }
  if (!destination.temporaryIdentity) {
    throw new Error(`Migration temporary identity was not durably recorded: ${destination.temporaryPath}`);
  }
  assertFilesystemIdentity(
    temporary,
    destination.temporaryIdentity,
    `${file.ownerFile} migration temporary`,
  );
}

export function publishDestination(input: {
  file: FileReceiptEntry;
  destination: DestinationReceiptEntry;
  pins: DestinationPins;
  systemDirectory: PinnedDirectory;
  onTemporaryCreated: (identity: FilesystemIdentity) => void;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): PublishedDestinationIdentities {
  const { file, destination } = input;
  const { destinationDirectory, stagingDirectory } = input.pins;
  assertFilesystemIdentity(
    destinationDirectory.identity,
    destination.companionDataDirIdentity,
    `${file.ownerFile} migration destination directory`,
  );
  assertFilesystemIdentity(
    stagingDirectory.identity,
    requireStagingDirectoryIdentity(destination),
    `${file.ownerFile} migration staging directory`,
  );

  if (!pinnedLeafExists(destinationDirectory, file.ownerFile)) {
    copySourceToTemporary({
      file,
      destination,
      systemDirectory: input.systemDirectory,
      stagingDirectory,
      onTemporaryCreated: input.onTemporaryCreated,
      faultInjection: input.faultInjection,
    });
    linkSync(
      pinnedLeafPath(stagingDirectory, basename(destination.temporaryPath)),
      pinnedLeafPath(destinationDirectory, file.ownerFile),
    );
    input.faultInjection?.({
      stage: 'after_publish',
      ownerFile: file.ownerFile,
      companionId: destination.companionId,
      path: destination.destinationPath,
    });
  }

  const identity = verifyDestination(file, destination, input.pins);
  fsyncSync(destinationDirectory.descriptor);
  input.faultInjection?.({
    stage: 'after_publish_directory_sync',
    ownerFile: file.ownerFile,
    companionId: destination.companionId,
    path: destination.destinationPath,
  });
  return identity;
}

export function verifyDestination(
  file: FileReceiptEntry,
  destination: DestinationReceiptEntry,
  pins: DestinationPins,
): PublishedDestinationIdentities {
  assertFilesystemIdentity(
    pins.destinationDirectory.identity,
    destination.companionDataDirIdentity,
    `${file.ownerFile} migration destination directory`,
  );
  assertFilesystemIdentity(
    pins.stagingDirectory.identity,
    requireStagingDirectoryIdentity(destination),
    `${file.ownerFile} migration staging directory`,
  );
  if (!pinnedLeafExists(pins.destinationDirectory, file.ownerFile)) {
    throw new Error(`Verified destination disappeared for ${file.ownerFile}: ${destination.destinationPath}`);
  }
  const inspected = inspectPinnedRegularFile(
    pins.destinationDirectory,
    file.ownerFile,
    `${file.ownerFile} migration destination`,
    { fsync: true },
  );
  if (inspected.sha256 !== file.sourceSha256 || inspected.bytes !== file.sourceBytes) {
    throw new Error(
      `Destination conflict for ${file.ownerFile} at ${destination.destinationPath}: `
        + `expected ${file.sourceSha256}, found ${inspected.sha256}`,
    );
  }
  if (destination.destinationIdentity) {
    assertFilesystemIdentity(
      inspected,
      destination.destinationIdentity,
      `${file.ownerFile} migration destination`,
    );
  }
  const temporary = inspectPinnedRegularFile(
    pins.stagingDirectory,
    basename(destination.temporaryPath),
    `${file.ownerFile} migration temporary`,
    { fsync: true },
  );
  if (temporary.sha256 !== file.sourceSha256 || temporary.bytes !== file.sourceBytes) {
    throw new Error(`Migration-owned temporary conflict for ${file.ownerFile}: ${destination.temporaryPath}`);
  }
  if (destination.temporaryIdentity) {
    assertFilesystemIdentity(
      temporary,
      destination.temporaryIdentity,
      `${file.ownerFile} migration temporary`,
    );
  }
  assertFilesystemIdentity(
    temporary,
    inspected,
    `${file.ownerFile} migration publish hard link`,
  );
  return {
    destinationIdentity: { device: inspected.device, inode: inspected.inode },
    temporaryIdentity: { device: temporary.device, inode: temporary.inode },
  };
}

export function assertSourceUnchanged(
  file: FileReceiptEntry,
  systemDirectory: PinnedDirectory,
): void {
  if (!pinnedLeafExists(systemDirectory, file.ownerFile)) {
    throw new Error(`Migration source disappeared before retirement: ${file.sourcePath}`);
  }
  const source = inspectPinnedRegularFile(
    systemDirectory,
    file.ownerFile,
    `${file.ownerFile} migration source`,
  );
  assertFilesystemIdentity(source, file.sourceIdentity, `${file.ownerFile} migration source`);
  if (source.sha256 !== file.sourceSha256 || source.bytes !== file.sourceBytes) {
    throw new Error(
      `Source changed for ${file.ownerFile}: expected ${file.sourceSha256}, found ${source.sha256}`,
    );
  }
}

export function destinationPinKey(companionId: string): string {
  return companionId;
}

export function openStagingDirectoryPins(input: {
  destinationDirectory: PinnedDirectory;
  label: string;
  stagingDirectoryName: string;
  create: boolean;
  exclusiveStagingCreate: boolean;
}): DestinationPins {
  try {
    const stagingDirectory = pinRelativeDirectory(
      input.destinationDirectory,
      input.stagingDirectoryName,
      `${input.label} staging directory`,
      {
        create: input.create,
        exclusiveLeafCreate: input.exclusiveStagingCreate,
        mode: 0o700,
      },
    );
    if (!stagingDirectory) throw new Error(`${input.label} staging directory is missing`);
    return { destinationDirectory: input.destinationDirectory, stagingDirectory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Pre-existing migration-owned staging directory conflicts for ${input.label}`);
    }
    throw error;
  }
}

export function closeDestinationPins(destinations: ReadonlyMap<string, DestinationPins>): void {
  for (const pins of destinations.values()) {
    closePinnedDirectory(pins.stagingDirectory);
    closePinnedDirectory(pins.destinationDirectory);
  }
}

export function verifyQuarantinedSource(
  file: FileReceiptEntry,
  quarantineDirectory: PinnedDirectory,
): void {
  const quarantine = inspectPinnedRegularFile(
    quarantineDirectory,
    basename(file.quarantinePath),
    `${file.ownerFile} migration quarantine`,
    { fsync: true },
  );
  assertFilesystemIdentity(quarantine, file.sourceIdentity, `${file.ownerFile} quarantined source`);
  if (quarantine.sha256 !== file.sourceSha256 || quarantine.bytes !== file.sourceBytes) {
    throw new Error(
      `Quarantined source changed for ${file.ownerFile}: expected ${file.sourceSha256}, found ${quarantine.sha256}`,
    );
  }
}

export function retireSource(input: {
  file: FileReceiptEntry;
  systemDirectory: PinnedDirectory;
  quarantineDirectory: PinnedDirectory;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): void {
  const { file, systemDirectory, quarantineDirectory } = input;
  const quarantineLeaf = basename(file.quarantinePath);
  const sourceExists = pinnedLeafExists(systemDirectory, file.ownerFile);
  const quarantineExists = pinnedLeafExists(quarantineDirectory, quarantineLeaf);
  if (!sourceExists) {
    if (!quarantineExists) {
      throw new Error(`Migration source disappeared outside quarantine: ${file.sourcePath}`);
    }
    verifyQuarantinedSource(file, quarantineDirectory);
    return;
  }
  if (quarantineExists) {
    throw new Error(`Migration source and quarantine both exist for ${file.ownerFile}; refusing recovery`);
  }

  assertSourceUnchanged(file, systemDirectory);
  input.faultInjection?.({
    stage: 'before_source_retirement',
    ownerFile: file.ownerFile,
    path: file.sourcePath,
  });
  renameSync(
    pinnedLeafPath(systemDirectory, file.ownerFile),
    pinnedLeafPath(quarantineDirectory, quarantineLeaf),
  );
  input.faultInjection?.({
    stage: 'after_source_quarantine',
    ownerFile: file.ownerFile,
    path: file.quarantinePath,
  });
  try {
    verifyQuarantinedSource(file, quarantineDirectory);
  } catch (error) {
    fsyncSync(systemDirectory.descriptor);
    fsyncSync(quarantineDirectory.descriptor);
    throw new Error(
      `Source replacement was preserved in quarantine for ${file.ownerFile}; retirement denied: ${(error as Error).message}`,
    );
  }
  fsyncSync(systemDirectory.descriptor);
  fsyncSync(quarantineDirectory.descriptor);
  input.faultInjection?.({
    stage: 'after_quarantine_sync',
    ownerFile: file.ownerFile,
    path: file.quarantinePath,
  });
}
