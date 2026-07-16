import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../system/config/companions-config.js';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import {
  ensureDirectoryDurableSync,
  fsyncDirectorySync,
  unlinkDurableSync,
  writeFileDurableAtomicSync,
} from '../shared/utils/fs.js';
import { isRecord } from '../shared/utils/types.js';
import { resolveCanonicalPathInsideRoot } from '../system/config/companion-workspace-layout.js';

const MIGRATION_RECEIPT_RELATIVE_PATH = join(
  'migrations',
  'system-owner-fleet-reroot.json',
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type DestinationStatus = 'pending' | 'verified';
type FileStatus = 'pending' | 'retired';

interface FleetReceiptEntry {
  companionId: string;
  companionDataDir: string;
}

interface DestinationReceiptEntry extends FleetReceiptEntry {
  destinationPath: string;
  temporaryPath: string;
  sha256: string;
  status: DestinationStatus;
  verifiedAt?: string;
}

interface FileReceiptEntry {
  ownerFile: string;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  status: FileStatus;
  destinations: DestinationReceiptEntry[];
  retiredAt?: string;
}

interface SystemOwnerFleetMigrationReceipt {
  schemaVersion: 2;
  migration: 'system-owner-fleet-reroot';
  status: 'in_progress' | 'completed';
  systemDataDir: string;
  fleet: FleetReceiptEntry[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  files: FileReceiptEntry[];
}

export interface SystemOwnerFleetMigrationDestinationPlan extends FleetReceiptEntry {
  destinationPath: string;
  status: 'missing' | 'conflict';
  existingSha256?: string;
}

export interface SystemOwnerFleetMigrationFilePlan {
  ownerFile: string;
  sourcePath: string;
  status: 'absent' | 'ready' | 'conflict';
  sourceSha256?: string;
  sourceBytes?: number;
  destinations: SystemOwnerFleetMigrationDestinationPlan[];
}

export interface SystemOwnerFleetMigrationPlan {
  receiptPath: string;
  systemDataDir: string;
  fleet: FleetReceiptEntry[];
  files: SystemOwnerFleetMigrationFilePlan[];
  sourceCount: number;
  conflictCount: number;
  canApply: boolean;
}

export interface SystemOwnerFleetMigrationResult {
  status: 'not_needed' | 'migrated' | 'already_completed';
  receiptPath: string;
  migratedOwnerFiles: string[];
}

export interface SystemOwnerFleetMigrationOptions {
  systemDataDir: string;
  fleet: ResolvedCompanionsFleetConfig;
  expectedSourceDigests: Readonly<Record<string, string>>;
  now?: () => Date;
  afterDestinationVerified?: (input: {
    ownerFile: string;
    companionId: string;
    destinationPath: string;
  }) => void;
  faultInjection?: (input: {
    stage:
      | 'during_temporary_copy'
      | 'after_temporary_fsync'
      | 'after_publish'
      | 'after_publish_directory_sync'
      | 'before_receipt_update'
      | 'after_receipt_update'
      | 'before_source_retirement'
      | 'after_source_unlink';
    ownerFile: string;
    companionId?: string;
    path: string;
  }) => void;
  temporaryId?: () => string;
}

function inspectRegularFile(path: string, label: string): { bytes: number; sha256: string } {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular file without symlinks: ${path}`);
    }
    return {
      bytes: stats.size,
      sha256: createHash('sha256').update(readFileSync(descriptor)).digest('hex'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file without symlinks: ${path}`);
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function receiptPath(systemDataDir: string): string {
  return join(resolve(systemDataDir), MIGRATION_RECEIPT_RELATIVE_PATH);
}

function assertDestinationContained(
  persistenceRoot: string,
  destinationPath: string,
  ownerFile: string,
): void {
  const expected = resolve(destinationPath);
  const canonical = resolveCanonicalPathInsideRoot(
    expected,
    persistenceRoot,
    `${ownerFile} migration destination`,
  );
  if (canonical !== expected) {
    throw new Error(
      `${ownerFile} migration destination resolves through a symlink: ${destinationPath}`,
    );
  }
}

function fleetEntries(fleet: ResolvedCompanionsFleetConfig): FleetReceiptEntry[] {
  return fleet.companions.map(entry => ({
    companionId: entry.companionId,
    companionDataDir: resolve(entry.companionDataDir),
  }));
}

function isFleetEntry(value: unknown): value is FleetReceiptEntry {
  return isRecord(value)
    && typeof value.companionId === 'string'
    && typeof value.companionDataDir === 'string';
}

function isDestinationEntry(value: unknown): value is DestinationReceiptEntry {
  return isFleetEntry(value)
    && typeof value.destinationPath === 'string'
    && typeof value.temporaryPath === 'string'
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
    && (value.status === 'pending' || value.status === 'verified')
    && (value.verifiedAt === undefined || typeof value.verifiedAt === 'string');
}

function isFileEntry(value: unknown): value is FileReceiptEntry {
  return isRecord(value)
    && typeof value.ownerFile === 'string'
    && PER_COMPANION_OWNER_FILES.has(value.ownerFile)
    && typeof value.sourcePath === 'string'
    && typeof value.sourceSha256 === 'string'
    && SHA256_PATTERN.test(value.sourceSha256)
    && typeof value.sourceBytes === 'number'
    && Number.isSafeInteger(value.sourceBytes)
    && value.sourceBytes >= 0
    && (value.status === 'pending' || value.status === 'retired')
    && Array.isArray(value.destinations)
    && value.destinations.every(isDestinationEntry)
    && (value.retiredAt === undefined || typeof value.retiredAt === 'string');
}

function loadReceipt(path: string): SystemOwnerFleetMigrationReceipt {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || value.migration !== 'system-owner-fleet-reroot'
    || (value.status !== 'in_progress' && value.status !== 'completed')
    || typeof value.systemDataDir !== 'string'
    || !Array.isArray(value.fleet)
    || !value.fleet.every(isFleetEntry)
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.completedAt !== undefined && typeof value.completedAt !== 'string')
    || !Array.isArray(value.files)
    || !value.files.every(isFileEntry)) {
    throw new Error(`Malformed system-owner fleet migration receipt: ${path}`);
  }
  return value as unknown as SystemOwnerFleetMigrationReceipt;
}

function writeReceipt(path: string, receipt: SystemOwnerFleetMigrationReceipt): void {
  writeFileDurableAtomicSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function assertReceiptIdentity(
  receipt: SystemOwnerFleetMigrationReceipt,
  systemDataDir: string,
  fleet: readonly FleetReceiptEntry[],
): void {
  if (resolve(receipt.systemDataDir) !== resolve(systemDataDir)
    || JSON.stringify(receipt.fleet) !== JSON.stringify(fleet)) {
    throw new Error(
      'System-owner fleet migration receipt does not match the current system root and configured companions',
    );
  }
}

function assertReceiptContents(
  receipt: SystemOwnerFleetMigrationReceipt,
  systemDataDir: string,
  fleet: readonly FleetReceiptEntry[],
): void {
  const registeredOwnerFiles = [...PER_COMPANION_OWNER_FILES];
  const receiptOwnerFiles = receipt.files.map(file => file.ownerFile);
  if (new Set(receiptOwnerFiles).size !== receiptOwnerFiles.length
    || receiptOwnerFiles.some((ownerFile, index) => (
      registeredOwnerFiles.indexOf(ownerFile)
        <= registeredOwnerFiles.indexOf(receiptOwnerFiles[index - 1] ?? '')
    ))) {
    throw new Error('System-owner fleet migration receipt owner files are duplicated or out of registry order');
  }

  for (const file of receipt.files) {
    if (resolve(file.sourcePath) !== join(systemDataDir, file.ownerFile)) {
      throw new Error(`System-owner fleet migration receipt has an invalid source path for ${file.ownerFile}`);
    }
    const expectedDestinations = fleet.map(entry => ({
      companionId: entry.companionId,
      companionDataDir: entry.companionDataDir,
      destinationPath: join(entry.companionDataDir, file.ownerFile),
    }));
    if (file.destinations.length !== expectedDestinations.length) {
      throw new Error(`System-owner fleet migration receipt has incomplete destinations for ${file.ownerFile}`);
    }
    for (let index = 0; index < expectedDestinations.length; index += 1) {
      const destination = file.destinations[index];
      const expected = expectedDestinations[index];
      if (destination.companionId !== expected.companionId
        || resolve(destination.companionDataDir) !== expected.companionDataDir
        || resolve(destination.destinationPath) !== expected.destinationPath
        || dirname(resolve(destination.temporaryPath)) !== dirname(expected.destinationPath)
        || !basename(destination.temporaryPath).startsWith(
          `.${basename(expected.destinationPath)}.system-owner-fleet-reroot-`,
        )
        || !basename(destination.temporaryPath).endsWith('.tmp')
        || destination.sha256 !== file.sourceSha256
        || (destination.status === 'verified' && !destination.verifiedAt)) {
        throw new Error(`System-owner fleet migration receipt destination mismatch for ${file.ownerFile}`);
      }
    }
    if (file.status === 'retired'
      && (!file.retiredAt || file.destinations.some(destination => destination.status !== 'verified'))) {
      throw new Error(`System-owner fleet migration receipt retired ${file.ownerFile} before verification`);
    }
  }
  if (receipt.status === 'completed'
    && (!receipt.completedAt || receipt.files.some(file => file.status !== 'retired'))) {
    throw new Error('Completed system-owner fleet migration receipt contains unfinished files');
  }

  for (const ownerFile of registeredOwnerFiles) {
    if (!receiptOwnerFiles.includes(ownerFile) && lstatPathExists(join(systemDataDir, ownerFile))) {
      throw new Error(`Untracked system-root per-companion owner file appeared after receipt creation: ${ownerFile}`);
    }
  }
}

function requireExpectedDigests(
  files: readonly Pick<FileReceiptEntry, 'ownerFile' | 'sourceSha256'>[],
  expectedSourceDigests: Readonly<Record<string, string>>,
): void {
  const expectedKeys = Object.keys(expectedSourceDigests).sort();
  const fileKeys = files.map(file => file.ownerFile).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(fileKeys)) {
    throw new Error(
      `Expected source-digest approvals for exactly ${fileKeys.join(', ') || '(no files)'}`,
    );
  }
  for (const file of files) {
    const expected = expectedSourceDigests[file.ownerFile].trim();
    if (!expected || !SHA256_PATTERN.test(expected)) {
      throw new Error(`Approval for ${file.ownerFile} must be an exact lowercase SHA-256 digest`);
    }
    if (expected !== file.sourceSha256) {
      throw new Error(
        `Source digest changed for ${file.ownerFile}: expected ${expected}, found ${file.sourceSha256}`,
      );
    }
  }
}

export function buildSystemOwnerFleetMigrationPlan(input: {
  systemDataDir: string;
  fleet: ResolvedCompanionsFleetConfig;
}): SystemOwnerFleetMigrationPlan {
  const systemDataDir = resolve(input.systemDataDir);
  const fleet = fleetEntries(input.fleet);
  const path = receiptPath(systemDataDir);
  if (lstatPathExists(path)) {
    const receipt = loadReceipt(path);
    assertReceiptIdentity(receipt, systemDataDir, fleet);
    assertReceiptContents(receipt, systemDataDir, fleet);
    throw new Error(
      `A system-owner fleet migration receipt already exists at ${path}; rerun the apply command with its original digest approvals`,
    );
  }

  const files = [...PER_COMPANION_OWNER_FILES].map((ownerFile): SystemOwnerFleetMigrationFilePlan => {
    const sourcePath = join(systemDataDir, ownerFile);
    if (!lstatPathExists(sourcePath)) {
      return {
        ownerFile,
        sourcePath,
        status: 'absent',
        destinations: [],
      };
    }
    const source = inspectRegularFile(sourcePath, `${ownerFile} migration source`);
    const destinations = fleet.map((entry): SystemOwnerFleetMigrationDestinationPlan => {
      const destinationPath = join(entry.companionDataDir, ownerFile);
      assertDestinationContained(input.fleet.persistenceRoot, destinationPath, ownerFile);
      if (!lstatPathExists(destinationPath)) {
        return { ...entry, destinationPath, status: 'missing' };
      }
      const existing = inspectRegularFile(destinationPath, `${ownerFile} migration destination`);
      return {
        ...entry,
        destinationPath,
        status: 'conflict',
        existingSha256: existing.sha256,
      };
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
}

function buildTemporaryPath(destinationPath: string, temporaryId: string): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(temporaryId)) {
    throw new Error('System-owner fleet migration temporary id is invalid');
  }
  return join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.system-owner-fleet-reroot-${temporaryId}.tmp`,
  );
}

function lstatPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function removeOwnedTemporary(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Migration-owned temporary path is not a regular file: ${path}`);
  }
  unlinkDurableSync(path);
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
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): void {
  const { file, destination } = input;
  if (lstatPathExists(destination.temporaryPath)) {
    const existing = inspectRegularFile(
      destination.temporaryPath,
      `${file.ownerFile} migration temporary`,
    );
    if (existing.sha256 === file.sourceSha256 && existing.bytes === file.sourceBytes) {
      return;
    }
    removeOwnedTemporary(destination.temporaryPath);
  }

  const sourceDescriptor = openSync(
    file.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let temporaryDescriptor: number | null = null;
  try {
    temporaryDescriptor = openSync(
      destination.temporaryPath,
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
  assertSourceUnchanged(file);
  const temporary = inspectRegularFile(
    destination.temporaryPath,
    `${file.ownerFile} migration temporary`,
  );
  if (temporary.sha256 !== file.sourceSha256 || temporary.bytes !== file.sourceBytes) {
    throw new Error(`Temporary copy verification failed for ${file.ownerFile}`);
  }
}

function publishDestination(input: {
  file: FileReceiptEntry;
  destination: DestinationReceiptEntry;
  persistenceRoot: string;
  faultInjection?: SystemOwnerFleetMigrationOptions['faultInjection'];
}): void {
  const { file, destination } = input;
  assertDestinationContained(input.persistenceRoot, destination.destinationPath, file.ownerFile);
  ensureDirectoryDurableSync(dirname(destination.destinationPath));

  if (!lstatPathExists(destination.destinationPath)) {
    copySourceToTemporary({ file, destination, faultInjection: input.faultInjection });
    linkSync(destination.temporaryPath, destination.destinationPath);
    input.faultInjection?.({
      stage: 'after_publish',
      ownerFile: file.ownerFile,
      companionId: destination.companionId,
      path: destination.destinationPath,
    });
  }

  verifyDestination(file, destination, input.persistenceRoot);
  fsyncDirectorySync(dirname(destination.destinationPath));
  input.faultInjection?.({
    stage: 'after_publish_directory_sync',
    ownerFile: file.ownerFile,
    companionId: destination.companionId,
    path: destination.destinationPath,
  });
  if (lstatPathExists(destination.temporaryPath)) removeOwnedTemporary(destination.temporaryPath);
}

function verifyDestination(
  file: FileReceiptEntry,
  destination: DestinationReceiptEntry,
  persistenceRoot: string,
): void {
  assertDestinationContained(persistenceRoot, destination.destinationPath, file.ownerFile);
  if (!lstatPathExists(destination.destinationPath)) {
    throw new Error(
      `Verified destination disappeared for ${file.ownerFile}: ${destination.destinationPath}`,
    );
  }
  const inspected = inspectRegularFile(
    destination.destinationPath,
    `${file.ownerFile} migration destination`,
  );
  if (inspected.sha256 !== file.sourceSha256 || inspected.bytes !== file.sourceBytes) {
    throw new Error(
      `Destination conflict for ${file.ownerFile} at ${destination.destinationPath}: `
        + `expected ${file.sourceSha256}, found ${inspected.sha256}`,
    );
  }
  const descriptor = openSync(
    destination.destinationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertSourceUnchanged(file: FileReceiptEntry): void {
  if (!lstatPathExists(file.sourcePath)) {
    throw new Error(`Migration source disappeared before retirement: ${file.sourcePath}`);
  }
  const source = inspectRegularFile(file.sourcePath, `${file.ownerFile} migration source`);
  if (source.sha256 !== file.sourceSha256 || source.bytes !== file.sourceBytes) {
    throw new Error(
      `Source changed for ${file.ownerFile}: expected ${file.sourceSha256}, found ${source.sha256}`,
    );
  }
}

function verifyCompletedReceipt(
  receipt: SystemOwnerFleetMigrationReceipt,
  persistenceRoot: string,
): void {
  for (const file of receipt.files) {
    if (file.status !== 'retired' || lstatPathExists(file.sourcePath)) {
      throw new Error(`Completed migration receipt has a live or unretired source: ${file.sourcePath}`);
    }
    for (const destination of file.destinations) {
      if (destination.status !== 'verified') {
        throw new Error(`Completed migration receipt has an unverified destination: ${destination.destinationPath}`);
      }
      verifyDestination(file, destination, persistenceRoot);
    }
  }
}

export function executeSystemOwnerFleetMigration(
  options: SystemOwnerFleetMigrationOptions,
): SystemOwnerFleetMigrationResult {
  const systemDataDir = resolve(options.systemDataDir);
  const fleet = fleetEntries(options.fleet);
  const path = receiptPath(systemDataDir);
  const now = options.now ?? (() => new Date());
  let receipt: SystemOwnerFleetMigrationReceipt;

  if (lstatPathExists(path)) {
    receipt = loadReceipt(path);
    assertReceiptIdentity(receipt, systemDataDir, fleet);
    assertReceiptContents(receipt, systemDataDir, fleet);
    requireExpectedDigests(receipt.files, options.expectedSourceDigests);
    if (receipt.status === 'completed') {
      verifyCompletedReceipt(receipt, options.fleet.persistenceRoot);
      return {
        status: 'already_completed',
        receiptPath: path,
        migratedOwnerFiles: receipt.files.map(file => file.ownerFile),
      };
    }
  } else {
    const plan = buildSystemOwnerFleetMigrationPlan({ systemDataDir, fleet: options.fleet });
    if (plan.sourceCount === 0) {
      requireExpectedDigests([], options.expectedSourceDigests);
      return { status: 'not_needed', receiptPath: path, migratedOwnerFiles: [] };
    }
    if (!plan.canApply) {
      const conflicts = plan.files
        .filter(file => file.status === 'conflict')
        .flatMap(file => file.destinations
          .filter(destination => destination.status === 'conflict')
          .map(destination => `${file.ownerFile}:${destination.destinationPath}`))
        .join(', ');
      throw new Error(`Refusing system-owner fleet migration with destination conflicts: ${conflicts}`);
    }
    const sourceFiles = plan.files.filter((file): file is SystemOwnerFleetMigrationFilePlan & {
      status: 'ready'; sourceSha256: string; sourceBytes: number;
    } => file.status === 'ready');
    requireExpectedDigests(sourceFiles, options.expectedSourceDigests);
    const startedAt = now().toISOString();
    const temporaryId = options.temporaryId ?? randomUUID;
    receipt = {
      schemaVersion: 2,
      migration: 'system-owner-fleet-reroot',
      status: 'in_progress',
      systemDataDir,
      fleet,
      startedAt,
      updatedAt: startedAt,
      files: sourceFiles.map(file => ({
        ownerFile: file.ownerFile,
        sourcePath: file.sourcePath,
        sourceSha256: file.sourceSha256,
        sourceBytes: file.sourceBytes,
        status: 'pending',
        destinations: file.destinations.map(destination => {
          const temporaryPath = buildTemporaryPath(destination.destinationPath, temporaryId());
          if (lstatPathExists(temporaryPath)) {
            throw new Error(`Pre-existing migration temporary path conflicts: ${temporaryPath}`);
          }
          return {
            companionId: destination.companionId,
            companionDataDir: destination.companionDataDir,
            destinationPath: destination.destinationPath,
            temporaryPath,
            sha256: file.sourceSha256,
            status: 'pending',
          };
        }),
      })),
    };
    writeReceipt(path, receipt);
  }

  for (const file of receipt.files) {
    if (file.status === 'retired') {
      if (lstatPathExists(file.sourcePath)) {
        throw new Error(`Retired migration source reappeared: ${file.sourcePath}`);
      }
      for (const destination of file.destinations) {
        verifyDestination(file, destination, options.fleet.persistenceRoot);
      }
      continue;
    }

    const allRecordedVerified = file.destinations.every(destination => destination.status === 'verified');
    if (!lstatPathExists(file.sourcePath)) {
      if (!allRecordedVerified) {
        throw new Error(`Migration source disappeared before every destination verified: ${file.sourcePath}`);
      }
      for (const destination of file.destinations) {
        verifyDestination(file, destination, options.fleet.persistenceRoot);
      }
      file.status = 'retired';
      const retiredAt = now().toISOString();
      file.retiredAt = retiredAt;
      receipt.updatedAt = retiredAt;
      writeReceipt(path, receipt);
      continue;
    }

    assertSourceUnchanged(file);
    for (const destination of file.destinations) {
      if (destination.status === 'verified') {
        verifyDestination(file, destination, options.fleet.persistenceRoot);
        continue;
      }
      assertSourceUnchanged(file);
      publishDestination({
        file,
        destination,
        persistenceRoot: options.fleet.persistenceRoot,
        faultInjection: options.faultInjection,
      });
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
      writeReceipt(path, receipt);
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

    assertSourceUnchanged(file);
    for (const destination of file.destinations) {
      verifyDestination(file, destination, options.fleet.persistenceRoot);
    }
    options.faultInjection?.({
      stage: 'before_source_retirement',
      ownerFile: file.ownerFile,
      path: file.sourcePath,
    });
    unlinkDurableSync(file.sourcePath);
    options.faultInjection?.({
      stage: 'after_source_unlink',
      ownerFile: file.ownerFile,
      path: file.sourcePath,
    });
    file.status = 'retired';
    const retiredAt = now().toISOString();
    file.retiredAt = retiredAt;
    receipt.updatedAt = retiredAt;
    writeReceipt(path, receipt);
  }

  receipt.status = 'completed';
  const completedAt = now().toISOString();
  receipt.completedAt = completedAt;
  receipt.updatedAt = completedAt;
  writeReceipt(path, receipt);
  return {
    status: 'migrated',
    receiptPath: path,
    migratedOwnerFiles: receipt.files.map(file => file.ownerFile),
  };
}
