import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../system/config/companions-config.js';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';
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
  schemaVersion: 1;
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
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inspectRegularFile(path: string, label: string): { bytes: number; sha256: string } {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file without symlinks: ${path}`);
  }
  return {
    bytes: stats.size,
    sha256: hashFile(path),
  };
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
    || value.schemaVersion !== 1
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
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, receipt);
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
    if (!receiptOwnerFiles.includes(ownerFile) && existsSync(join(systemDataDir, ownerFile))) {
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
    const expected = expectedSourceDigests[file.ownerFile]?.trim();
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
  if (existsSync(path)) {
    const receipt = loadReceipt(path);
    assertReceiptIdentity(receipt, systemDataDir, fleet);
    assertReceiptContents(receipt, systemDataDir, fleet);
    throw new Error(
      `A system-owner fleet migration receipt already exists at ${path}; rerun the apply command with its original digest approvals`,
    );
  }

  const files = [...PER_COMPANION_OWNER_FILES].map((ownerFile): SystemOwnerFleetMigrationFilePlan => {
    const sourcePath = join(systemDataDir, ownerFile);
    if (!existsSync(sourcePath)) {
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
      if (!existsSync(destinationPath)) {
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

function verifyDestination(
  file: FileReceiptEntry,
  destination: DestinationReceiptEntry,
  persistenceRoot: string,
): void {
  assertDestinationContained(persistenceRoot, destination.destinationPath, file.ownerFile);
  if (!existsSync(destination.destinationPath)) {
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
}

function assertSourceUnchanged(file: FileReceiptEntry): void {
  if (!existsSync(file.sourcePath)) {
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
    if (file.status !== 'retired' || existsSync(file.sourcePath)) {
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

  if (existsSync(path)) {
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
    receipt = {
      schemaVersion: 1,
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
        destinations: file.destinations.map(destination => ({
          companionId: destination.companionId,
          companionDataDir: destination.companionDataDir,
          destinationPath: destination.destinationPath,
          sha256: file.sourceSha256,
          status: 'pending',
        })),
      })),
    };
    writeReceipt(path, receipt);
  }

  for (const file of receipt.files) {
    if (file.status === 'retired') {
      if (existsSync(file.sourcePath)) {
        throw new Error(`Retired migration source reappeared: ${file.sourcePath}`);
      }
      for (const destination of file.destinations) {
        verifyDestination(file, destination, options.fleet.persistenceRoot);
      }
      continue;
    }

    const allRecordedVerified = file.destinations.every(destination => destination.status === 'verified');
    if (!existsSync(file.sourcePath)) {
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
      if (existsSync(destination.destinationPath)) {
        // Only an in-progress receipt can authorize deterministic recovery of
        // a copy that landed before its receipt update.
        verifyDestination(file, destination, options.fleet.persistenceRoot);
      } else {
        mkdirSync(dirname(destination.destinationPath), { recursive: true });
        copyFileSync(file.sourcePath, destination.destinationPath, constants.COPYFILE_EXCL);
        assertSourceUnchanged(file);
        verifyDestination(file, destination, options.fleet.persistenceRoot);
      }
      destination.status = 'verified';
      const verifiedAt = now().toISOString();
      destination.verifiedAt = verifiedAt;
      receipt.updatedAt = verifiedAt;
      writeReceipt(path, receipt);
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
    unlinkSync(file.sourcePath);
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
