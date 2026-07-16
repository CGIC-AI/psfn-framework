import {
  closeSync,
  constants,
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
  inspectPinnedRegularFile,
  pinRelativeDirectory,
  pinnedLeafExists,
  pinnedLeafPath,
  relativeDirectoryPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';
import {
  MIGRATION_STAGING_DIRECTORY,
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

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Temporary owner-file copy made no write progress');
    offset += written;
  }
}

function copySourceToTemporary(input: {
  file: FileReceiptEntry;
  destination: DestinationReceiptEntry;
  systemDirectory: PinnedDirectory;
  stagingDirectory: PinnedDirectory;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): void {
  const { file, destination } = input;
  const temporaryLeaf = basename(destination.temporaryPath);
  if (pinnedLeafExists(input.stagingDirectory, temporaryLeaf)) {
    const existing = inspectPinnedRegularFile(
      input.stagingDirectory,
      temporaryLeaf,
      `${file.ownerFile} migration temporary`,
    );
    if (existing.sha256 === file.sourceSha256 && existing.bytes === file.sourceBytes) return;
    throw new Error(`Migration-owned temporary conflict for ${file.ownerFile}: ${destination.temporaryPath}`);
  }

  const sourceDescriptor = openSync(
    pinnedLeafPath(input.systemDirectory, file.ownerFile),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let temporaryDescriptor: number | null = null;
  try {
    temporaryDescriptor = openSync(
      pinnedLeafPath(input.stagingDirectory, temporaryLeaf),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const sourceBytes = readFileSync(sourceDescriptor);
    const split = sourceBytes.length > 1 ? Math.ceil(sourceBytes.length / 2) : sourceBytes.length;
    if (split > 0) writeAll(temporaryDescriptor, sourceBytes.subarray(0, split));
    input.faultInjection?.({
      stage: 'during_temporary_copy',
      ownerFile: file.ownerFile,
      companionId: destination.companionId,
      path: destination.temporaryPath,
    });
    if (split < sourceBytes.length) writeAll(temporaryDescriptor, sourceBytes.subarray(split));
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
}

export function publishDestination(input: {
  file: FileReceiptEntry;
  destination: DestinationReceiptEntry;
  pins: DestinationPins;
  systemDirectory: PinnedDirectory;
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
    destination.stagingDirectoryIdentity,
    `${file.ownerFile} migration staging directory`,
  );

  if (!pinnedLeafExists(destinationDirectory, file.ownerFile)) {
    copySourceToTemporary({
      file,
      destination,
      systemDirectory: input.systemDirectory,
      stagingDirectory,
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
    destination.stagingDirectoryIdentity,
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

export function openDestinationPins(input: {
  persistenceDirectory: PinnedDirectory;
  companionDataDir: string;
  label: string;
  create: boolean;
  exclusiveStagingCreate: boolean;
}): DestinationPins {
  const relativePath = relativeDirectoryPath(
    input.persistenceDirectory,
    input.companionDataDir,
    input.label,
  );
  const destinationDirectory = pinRelativeDirectory(
    input.persistenceDirectory,
    relativePath,
    `${input.label} directory`,
    { create: input.create },
  );
  if (!destinationDirectory) throw new Error(`${input.label} directory is missing`);
  try {
    return openStagingDirectoryPins({
      destinationDirectory,
      label: input.label,
      create: input.create,
      exclusiveStagingCreate: input.exclusiveStagingCreate,
    });
  } catch (error) {
    closePinnedDirectory(destinationDirectory);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Pre-existing migration-owned staging directory conflicts for ${input.label}`);
    }
    throw error;
  }
}

export function openStagingDirectoryPins(input: {
  destinationDirectory: PinnedDirectory;
  label: string;
  create: boolean;
  exclusiveStagingCreate: boolean;
}): DestinationPins {
  try {
    const stagingDirectory = pinRelativeDirectory(
      input.destinationDirectory,
      MIGRATION_STAGING_DIRECTORY,
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
