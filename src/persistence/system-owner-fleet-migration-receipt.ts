import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../system/config/companions-config.js';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import { writeFileDurableAtomicSync } from '../shared/utils/fs.js';
import { isRecord } from '../shared/utils/types.js';
import {
  assertFilesystemIdentity,
  pinnedLeafPath,
  type FilesystemIdentity,
  type PinnedDirectory,
} from './pinned-filesystem.js';

export const MIGRATION_RECEIPT_RELATIVE_PATH = join(
  'migrations',
  'system-owner-fleet-reroot.json',
);
export const MIGRATION_ARTIFACT_PREFIX = '.system-owner-fleet-reroot-';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ARTIFACT_ID_PATTERN = /^[a-zA-Z0-9-]+$/u;

export function assertMigrationArtifactId(value: string): void {
  if (!ARTIFACT_ID_PATTERN.test(value)) {
    throw new Error('System-owner fleet migration artifact id is invalid');
  }
}

export function quarantineDirectoryName(operationId: string): string {
  assertMigrationArtifactId(operationId);
  return `${MIGRATION_ARTIFACT_PREFIX}quarantine-${operationId}`;
}

export function stagingDirectoryName(operationId: string): string {
  assertMigrationArtifactId(operationId);
  return `${MIGRATION_ARTIFACT_PREFIX}staging-${operationId}`;
}

export type DestinationStatus = 'pending' | 'verified';
export type FileStatus = 'pending' | 'retired';

export interface FleetReceiptEntry {
  companionId: string;
  companionDataDir: string;
}

export interface CurrentOwnerReceiptEntry {
  bytes: number;
  sha256: string;
  identity: FilesystemIdentity;
  observedAt: string;
  provenance: 'canonical-owner-after-verified-source-retirement';
}

export interface DestinationReceiptEntry extends FleetReceiptEntry {
  destinationPath: string;
  companionDataDirIdentity: FilesystemIdentity;
  stagingDirectoryPath: string;
  stagingDirectoryIdentity?: FilesystemIdentity;
  temporaryPath: string;
  temporaryIdentity?: FilesystemIdentity;
  copyGeneration: number;
  supersededTemporaryFiles: SupersededTemporaryReceiptEntry[];
  sha256: string;
  destinationIdentity?: FilesystemIdentity;
  status: DestinationStatus;
  verifiedAt?: string;
  currentOwner?: CurrentOwnerReceiptEntry;
}

export interface SupersededTemporaryReceiptEntry {
  path: string;
  identity: FilesystemIdentity;
  bytes: number;
  sha256: string;
}

export interface FileReceiptEntry {
  ownerFile: string;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  sourceIdentity: FilesystemIdentity;
  quarantinePath: string;
  status: FileStatus;
  destinations: DestinationReceiptEntry[];
  retiredAt?: string;
}

export interface SystemOwnerFleetMigrationReceipt {
  schemaVersion: 4;
  migration: 'system-owner-fleet-reroot';
  status: 'bootstrap' | 'in_progress' | 'completed';
  operationId: string;
  systemDataDir: string;
  systemDataDirIdentity: FilesystemIdentity;
  receiptDirectoryPath: string;
  receiptDirectoryIdentity: FilesystemIdentity;
  quarantineDirectoryPath: string;
  quarantineDirectoryIdentity?: FilesystemIdentity;
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
      | 'after_bootstrap_receipt'
      | 'after_quarantine_directory_create'
      | 'after_quarantine_identity_receipt'
      | 'after_staging_directory_create'
      | 'after_staging_identity_receipt'
      | 'after_bootstrap_finalize'
      | 'after_temporary_create'
      | 'after_temporary_identity_receipt'
      | 'after_temporary_superseded_receipt'
      | 'after_temporary_fsync'
      | 'after_publish'
      | 'after_publish_directory_sync'
      | 'before_receipt_update'
      | 'after_receipt_update'
      | 'before_source_retirement'
      | 'after_source_quarantine'
      | 'after_quarantine_sync'
      | 'before_final_receipt'
      | 'after_final_receipt';
    ownerFile: string;
    companionId?: string;
    path: string;
  }) => void;
  temporaryId?: () => string;
}

export function receiptPath(systemDataDir: string): string {
  return join(resolve(systemDataDir), MIGRATION_RECEIPT_RELATIVE_PATH);
}

function isFilesystemIdentity(value: unknown): value is FilesystemIdentity {
  return isRecord(value)
    && typeof value.device === 'string'
    && /^\d+$/u.test(value.device)
    && typeof value.inode === 'string'
    && /^\d+$/u.test(value.inode);
}

export function fleetEntries(fleet: ResolvedCompanionsFleetConfig): FleetReceiptEntry[] {
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

function isSupersededTemporaryEntry(value: unknown): value is SupersededTemporaryReceiptEntry {
  return isRecord(value)
    && typeof value.path === 'string'
    && isFilesystemIdentity(value.identity)
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256);
}

function isCurrentOwnerEntry(value: unknown): value is CurrentOwnerReceiptEntry {
  return isRecord(value)
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
    && isFilesystemIdentity(value.identity)
    && typeof value.observedAt === 'string'
    && value.provenance === 'canonical-owner-after-verified-source-retirement';
}

function isDestinationEntry(value: unknown): value is DestinationReceiptEntry {
  return isFleetEntry(value)
    && typeof value.destinationPath === 'string'
    && isFilesystemIdentity(value.companionDataDirIdentity)
    && typeof value.stagingDirectoryPath === 'string'
    && (value.stagingDirectoryIdentity === undefined
      || isFilesystemIdentity(value.stagingDirectoryIdentity))
    && typeof value.temporaryPath === 'string'
    && (value.temporaryIdentity === undefined || isFilesystemIdentity(value.temporaryIdentity))
    && typeof value.copyGeneration === 'number'
    && Number.isSafeInteger(value.copyGeneration)
    && value.copyGeneration >= 0
    && Array.isArray(value.supersededTemporaryFiles)
    && value.supersededTemporaryFiles.every(isSupersededTemporaryEntry)
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
    && (value.destinationIdentity === undefined || isFilesystemIdentity(value.destinationIdentity))
    && (value.status === 'pending' || value.status === 'verified')
    && (value.status !== 'verified' || isFilesystemIdentity(value.destinationIdentity))
    && (value.status !== 'verified' || isFilesystemIdentity(value.temporaryIdentity))
    && (value.verifiedAt === undefined || typeof value.verifiedAt === 'string')
    && (value.currentOwner === undefined || isCurrentOwnerEntry(value.currentOwner));
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
    && isFilesystemIdentity(value.sourceIdentity)
    && typeof value.quarantinePath === 'string'
    && (value.status === 'pending' || value.status === 'retired')
    && Array.isArray(value.destinations)
    && value.destinations.every(isDestinationEntry)
    && (value.retiredAt === undefined || typeof value.retiredAt === 'string');
}

export function loadReceipt(path: string, operationPath = path): SystemOwnerFleetMigrationReceipt {
  let descriptor: number | null = null;
  let value: unknown;
  try {
    descriptor = openSync(operationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    value = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Migration receipt must be a regular file without symlinks: ${path}`);
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  if (!isRecord(value)
    || value.schemaVersion !== 4
    || value.migration !== 'system-owner-fleet-reroot'
    || (value.status !== 'bootstrap' && value.status !== 'in_progress' && value.status !== 'completed')
    || typeof value.operationId !== 'string'
    || !ARTIFACT_ID_PATTERN.test(value.operationId)
    || typeof value.systemDataDir !== 'string'
    || !isFilesystemIdentity(value.systemDataDirIdentity)
    || typeof value.receiptDirectoryPath !== 'string'
    || !isFilesystemIdentity(value.receiptDirectoryIdentity)
    || typeof value.quarantineDirectoryPath !== 'string'
    || (value.quarantineDirectoryIdentity !== undefined
      && !isFilesystemIdentity(value.quarantineDirectoryIdentity))
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

export function writeReceipt(
  path: string,
  receipt: SystemOwnerFleetMigrationReceipt,
  receiptDirectory?: PinnedDirectory,
  exclusive = false,
): void {
  const operationPath = receiptDirectory
    ? pinnedLeafPath(receiptDirectory, basename(path))
    : path;
  writeFileDurableAtomicSync(operationPath, `${JSON.stringify(receipt, null, 2)}\n`, { exclusive });
}

export function assertReceiptIdentity(
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

export function assertReceiptPinnedIdentities(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  systemDataDir: PinnedDirectory;
  receiptDirectory: PinnedDirectory;
  quarantineDirectory: PinnedDirectory;
}): void {
  if (!input.receipt.quarantineDirectoryIdentity) {
    throw new Error('System-owner fleet migration quarantine identity is not initialized');
  }
  assertFilesystemIdentity(
    input.systemDataDir.identity,
    input.receipt.systemDataDirIdentity,
    'System-owner fleet migration system directory',
  );
  assertFilesystemIdentity(
    input.receiptDirectory.identity,
    input.receipt.receiptDirectoryIdentity,
    'System-owner fleet migration receipt directory',
  );
  assertFilesystemIdentity(
    input.quarantineDirectory.identity,
    input.receipt.quarantineDirectoryIdentity,
    'System-owner fleet migration quarantine directory',
  );
}

export function assertReceiptRootIdentities(input: {
  receipt: SystemOwnerFleetMigrationReceipt;
  systemDataDir: PinnedDirectory;
  receiptDirectory: PinnedDirectory;
}): void {
  assertFilesystemIdentity(
    input.systemDataDir.identity,
    input.receipt.systemDataDirIdentity,
    'System-owner fleet migration system directory',
  );
  assertFilesystemIdentity(
    input.receiptDirectory.identity,
    input.receipt.receiptDirectoryIdentity,
    'System-owner fleet migration receipt directory',
  );
}

export function assertReceiptContents(
  receipt: SystemOwnerFleetMigrationReceipt,
  systemDataDir: string,
  fleet: readonly FleetReceiptEntry[],
): void {
  const expectedQuarantineDirectory = join(
    resolve(receipt.receiptDirectoryPath),
    quarantineDirectoryName(receipt.operationId),
  );
  if (resolve(receipt.quarantineDirectoryPath) !== expectedQuarantineDirectory) {
    throw new Error('System-owner fleet migration receipt quarantine path is invalid');
  }
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
    if (dirname(resolve(file.quarantinePath)) !== resolve(receipt.quarantineDirectoryPath)
      || !basename(file.quarantinePath).startsWith(`${file.ownerFile}.`)
      || !basename(file.quarantinePath).endsWith('.retired')) {
      throw new Error(`System-owner fleet migration receipt has an invalid quarantine path for ${file.ownerFile}`);
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
        || resolve(destination.stagingDirectoryPath)
          !== join(expected.companionDataDir, stagingDirectoryName(receipt.operationId))
        || dirname(resolve(destination.temporaryPath)) !== resolve(destination.stagingDirectoryPath)
        || !basename(destination.temporaryPath).startsWith(
          `.${basename(expected.destinationPath)}.system-owner-fleet-reroot-`,
        )
        || !basename(destination.temporaryPath).endsWith('.tmp')
        || destination.sha256 !== file.sourceSha256
        || (destination.status === 'verified' && !destination.temporaryIdentity)
        || (destination.status === 'verified' && !destination.destinationIdentity)
        || (destination.status === 'verified' && !destination.verifiedAt)
        || (destination.status !== 'verified' && destination.currentOwner)
        || (file.status !== 'retired' && destination.currentOwner)) {
        throw new Error(`System-owner fleet migration receipt destination mismatch for ${file.ownerFile}`);
      }
      const supersededPaths = destination.supersededTemporaryFiles.map(entry => resolve(entry.path));
      if (new Set(supersededPaths).size !== supersededPaths.length
        || supersededPaths.includes(resolve(destination.temporaryPath))
        || supersededPaths.some(path => dirname(path) !== resolve(destination.stagingDirectoryPath))) {
        throw new Error(`System-owner fleet migration superseded temporary mismatch for ${file.ownerFile}`);
      }
    }
    if (file.status === 'retired'
      && (!file.retiredAt || file.destinations.some(destination => destination.status !== 'verified'))) {
      throw new Error(`System-owner fleet migration receipt retired ${file.ownerFile} before verification`);
    }
  }
  if (receipt.status === 'bootstrap'
    && receipt.files.some(file => file.status !== 'pending'
        || file.destinations.some(destination => destination.status !== 'pending'
          || destination.destinationIdentity
          || destination.temporaryIdentity
          || destination.currentOwner))) {
    throw new Error('Bootstrap system-owner fleet migration receipt contains post-bootstrap progress');
  }
  if (receipt.status !== 'bootstrap'
    && (!receipt.quarantineDirectoryIdentity
      || receipt.files.some(file => file.destinations.some(
        destination => !destination.stagingDirectoryIdentity,
      )))) {
    throw new Error('Initialized system-owner fleet migration receipt is missing directory identities');
  }
  if (receipt.status === 'completed'
    && (!receipt.completedAt || receipt.files.some(file => file.status !== 'retired'))) {
    throw new Error('Completed system-owner fleet migration receipt contains unfinished files');
  }
}

export function requireExpectedDigests(
  files: readonly Pick<FileReceiptEntry, 'ownerFile' | 'sourceSha256'>[],
  expectedSourceDigests: Readonly<Record<string, string>>,
): void {
  const expectedKeys = Object.keys(expectedSourceDigests).sort();
  const fileKeys = files.map(file => file.ownerFile).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(fileKeys)) {
    throw new Error(`Expected source-digest approvals for exactly ${fileKeys.join(', ') || '(no files)'}`);
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
