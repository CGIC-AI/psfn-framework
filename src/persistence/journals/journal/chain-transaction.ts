import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { JournalEntry } from '../../../core/session/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import { parseJournalText } from './file-io.js';

const CHAIN_REWRITE_MANIFEST_SUFFIX = '.chain-rewrite-manifest.json';

// The L0 journal is the companion's canonical, append-only history. The only
// destructive-in-place operation the charter sanctions on it is redaction:
// removing/replacing an entry's payload (content/summary and its provenance
// metadata) while its identity and authorship are preserved exactly, or
// re-signing an otherwise byte-identical entry. Anything else — rewriting the
// role/author of a canonical entry, reordering, inserting, or dropping entries —
// is a rewrite of history and must fail closed here (Charter Law 2 / 6.20 L0
// append-only, 7.4 supersede over destructive rewrite, 7.5 repair must not
// rewrite canonical). Growth of the chain is append-only and never travels
// through this primitive; corrections that are not redactions belong in a
// derived mirror or an in-stream supersede entry.
const REDACTION_IMMUTABLE_FIELDS: readonly (keyof JournalEntry)[] = [
  'type',
  'id',
  'channelId',
  'timestamp',
  'role',
  'authorId',
  'authorName',
  'discordMessageId',
  'originChannelId',
  'channelVisibility',
  'coveredUpTo',
  'marker',
  'tombstoneTargetType',
  'tombstoneTargetId',
  'tombstoneAction',
  'tombstoneActor',
  'tombstoneReason',
];

function assertRedactionOnlyRewrite(
  original: readonly JournalEntry[],
  replacement: readonly JournalEntry[],
  targetPath: string,
): void {
  if (original.length !== replacement.length) {
    throw new Error(
      'L0 chain rewrite must preserve entry count '
      + `(redaction supersedes entries in place; growth is append-only): ${basename(targetPath)}`,
    );
  }
  for (let index = 0; index < original.length; index += 1) {
    const originalEntry = original[index]!;
    const replacementEntry = replacement[index]!;
    for (const field of REDACTION_IMMUTABLE_FIELDS) {
      if (originalEntry[field] !== replacementEntry[field]) {
        throw new Error(
          `L0 chain rewrite may not alter '${field}' on entry id=${originalEntry.id}; `
          + `only redaction of an entry's content/summary is permitted: ${basename(targetPath)}`,
        );
      }
    }
    const contentChanged = originalEntry.content !== replacementEntry.content;
    const summaryChanged = originalEntry.summary !== replacementEntry.summary;
    const metadataChanged = originalEntry.metadata !== replacementEntry.metadata;
    if (metadataChanged && !contentChanged && !summaryChanged) {
      throw new Error(
        `L0 chain rewrite may not alter metadata without redacting content on entry id=${originalEntry.id}: `
        + basename(targetPath),
      );
    }
  }
}

function assertRedactionOnlyChainRewrite(
  targetPaths: readonly string[],
  replacementByTarget: readonly (readonly JournalEntry[])[],
  renewLease?: () => void,
): void {
  targetPaths.forEach((targetPath, index) => {
    // Derive the originals from disk, never from the caller: trusting a
    // caller-supplied "original" would let an arbitrary rewrite masquerade as a
    // redaction by claiming the replacement is already the original.
    const parsed = parseJournalText(readFileSync(targetPath, 'utf8'));
    if (parsed.quarantined.length > 0) {
      throw new Error(
        `Refusing L0 chain rewrite over a malformed journal file: ${basename(targetPath)}`,
      );
    }
    assertRedactionOnlyRewrite(parsed.entries, replacementByTarget[index]!, targetPath);
    renewLease?.();
  });
}

interface ChainRewriteFile {
  targetPath: string;
  stagedPath: string;
  backupPath: string;
}

interface ChainRewriteManifest {
  version: 1;
  transactionId: string;
  phase: 'staging' | 'prepared' | 'committed' | 'rolled_back';
  rootPath: string;
  files: ChainRewriteFile[];
}

function isChainRewritePhase(value: unknown): value is ChainRewriteManifest['phase'] {
  return value === 'staging'
    || value === 'prepared'
    || value === 'committed'
    || value === 'rolled_back';
}

function manifestPathForRoot(rootPath: string): string {
  return `${rootPath}${CHAIN_REWRITE_MANIFEST_SUFFIX}`;
}

function expectedChainTargetPath(rootPath: string, index: number): string {
  if (index === 0) return rootPath;
  return `${rootPath.slice(0, -'.jsonl'.length)}.segment-${(index + 1).toString().padStart(4, '0')}.jsonl`;
}

function targetsFormJournalChain(rootPath: string, targetPaths: readonly string[]): boolean {
  return rootPath.endsWith('.jsonl')
    && targetPaths.every((targetPath, index) => targetPath === expectedChainTargetPath(rootPath, index));
}

function journalChainTargetsOnDisk(rootPath: string): string[] {
  const rootDir = dirname(rootPath);
  const rootFilename = basename(rootPath);
  const segmentPrefix = `${rootFilename.slice(0, -'.jsonl'.length)}.segment-`;
  return readdirSync(rootDir)
    .filter(filename => (
      filename === rootFilename
      || (
        filename.startsWith(segmentPrefix)
        && filename.endsWith('.jsonl')
        && /^\d{4}$/.test(filename.slice(segmentPrefix.length, -'.jsonl'.length))
      )
    ))
    .sort()
    .map(filename => join(rootDir, filename));
}

function removeIfPresent(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}

function syncFile(filePath: string): void {
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(dirPath: string): void {
  const descriptor = openSync(dirPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeManifestDurable(manifestPath: string, manifest: ChainRewriteManifest): void {
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, manifestPath);
    syncDirectory(dirname(manifestPath));
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    removeIfPresent(tempPath);
    throw error;
  }
}

function parseManifest(manifestPath: string): ChainRewriteManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || !isChainRewritePhase(parsed.phase)
    || typeof parsed.transactionId !== 'string'
    || !/^[a-zA-Z0-9-]+$/.test(parsed.transactionId)
    || typeof parsed.rootPath !== 'string'
    || !isAbsolute(parsed.rootPath)
    || !Array.isArray(parsed.files)
    || parsed.files.length === 0
  ) {
    throw new Error(`Invalid L0 chain rewrite manifest: ${manifestPath}`);
  }

  const rootPath = resolve(parsed.rootPath);
  const rootDir = dirname(rootPath);
  const files: ChainRewriteFile[] = [];
  const targetPaths = new Set<string>();
  for (const rawFile of parsed.files) {
    if (
      !isRecord(rawFile)
      || typeof rawFile.targetPath !== 'string'
      || typeof rawFile.stagedPath !== 'string'
      || typeof rawFile.backupPath !== 'string'
    ) {
      throw new Error(`Invalid L0 chain rewrite manifest: ${manifestPath}`);
    }
    const targetPath = resolve(rawFile.targetPath);
    if (
      !isAbsolute(rawFile.targetPath)
      || targetPath !== rawFile.targetPath
      || dirname(targetPath) !== rootDir
      || targetPaths.has(targetPath)
      || rawFile.stagedPath !== `${targetPath}.${parsed.transactionId}.staged`
      || rawFile.backupPath !== `${targetPath}.${parsed.transactionId}.backup`
    ) {
      throw new Error(`Unsafe L0 chain rewrite manifest path: ${manifestPath}`);
    }
    targetPaths.add(targetPath);
    files.push({
      targetPath,
      stagedPath: rawFile.stagedPath,
      backupPath: rawFile.backupPath,
    });
  }
  if (
    files[0]?.targetPath !== rootPath
    || manifestPathForRoot(rootPath) !== manifestPath
    || !targetsFormJournalChain(rootPath, files.map(file => file.targetPath))
  ) {
    throw new Error(`L0 chain rewrite manifest root mismatch: ${manifestPath}`);
  }

  return {
    version: 1,
    transactionId: parsed.transactionId,
    phase: parsed.phase,
    rootPath,
    files,
  };
}

function cleanTransactionFiles(manifestPath: string, manifest: ChainRewriteManifest): void {
  for (const file of manifest.files) {
    removeIfPresent(file.stagedPath);
    removeIfPresent(file.backupPath);
  }
  removeIfPresent(manifestPath);
  syncDirectory(dirname(manifestPath));
}

function fingerprintTarget(filePath: string): string {
  const stats = statSync(filePath);
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
}

export function assertNoPendingJournalChainRewrite(rootPath: string): void {
  const manifestPath = manifestPathForRoot(rootPath);
  if (existsSync(manifestPath)) {
    throw new Error(
      `L0 session ${rootPath} has a pending chain rewrite; refusing to read or append until recovery`,
    );
  }
}

export function listPendingJournalChainRewriteRoots(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter(filename => filename.endsWith(CHAIN_REWRITE_MANIFEST_SUFFIX))
    .map(filename => join(
      sessionsDir,
      filename.slice(0, -CHAIN_REWRITE_MANIFEST_SUFFIX.length),
    ))
    .sort();
}

export function recoverJournalChainRewrite(rootPath: string): void {
  const manifestPath = manifestPathForRoot(rootPath);
  if (!existsSync(manifestPath)) return;
  const manifest = parseManifest(manifestPath);

  if (manifest.phase === 'prepared') {
    const missingBackups = manifest.files
      .filter(file => !existsSync(file.backupPath))
      .map(file => file.backupPath);
    if (missingBackups.length > 0) {
      throw new Error(
        `Cannot recover L0 chain rewrite; backup files are missing: ${missingBackups.join(', ')}`,
      );
    }
    for (const file of manifest.files) {
      copyFileSync(file.backupPath, file.targetPath);
      syncFile(file.targetPath);
    }
    syncDirectory(dirname(rootPath));
    writeManifestDurable(manifestPath, { ...manifest, phase: 'rolled_back' });
  } else if (manifest.phase === 'staging') {
    // No target is installed until the durable prepared phase. A staging
    // manifest therefore only owns cleanup artifacts, even if a process died
    // halfway through creating a backup or staged replacement.
    writeManifestDurable(manifestPath, { ...manifest, phase: 'rolled_back' });
  }
  cleanTransactionFiles(manifestPath, manifest);
}

export function rewriteJournalChainTransaction(params: {
  targetPaths: readonly string[];
  entriesByTarget: readonly (readonly JournalEntry[])[];
  writeEntries: (filePath: string, entries: readonly JournalEntry[]) => void;
  renewLease?: () => void;
  onDurablePhase?: (phase: ChainRewriteManifest['phase']) => void;
}): void {
  if (params.targetPaths.length === 0 || params.targetPaths.length !== params.entriesByTarget.length) {
    throw new Error('L0 chain rewrite requires one non-empty entry set list aligned to target files');
  }
  const rootPath = params.targetPaths[0]!;
  const rootDir = dirname(rootPath);
  if (
    !isAbsolute(rootPath)
    || params.targetPaths.some(targetPath => (
      !isAbsolute(targetPath)
      || resolve(targetPath) !== targetPath
      || dirname(targetPath) !== rootDir
    ))
    || params.targetPaths.length !== new Set(params.targetPaths).size
    || !targetsFormJournalChain(rootPath, params.targetPaths)
  ) {
    throw new Error(
      'L0 chain rewrite targets must be one ordered journal chain of unique absolute paths',
    );
  }
  const diskTargets = journalChainTargetsOnDisk(rootPath);
  if (
    diskTargets.length !== params.targetPaths.length
    || diskTargets.some((targetPath, index) => targetPath !== params.targetPaths[index])
  ) {
    throw new Error(
      `L0 chain changed before rewrite; refusing a partial transaction for ${basename(rootPath)}`,
    );
  }
  assertNoPendingJournalChainRewrite(rootPath);
  // Fail closed before any artifact is created if the replacement is not a
  // redaction/re-sign of the on-disk canonical entries.
  assertRedactionOnlyChainRewrite(params.targetPaths, params.entriesByTarget, params.renewLease);
  const originalFingerprints = params.targetPaths.map(fingerprintTarget);
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const files = params.targetPaths.map((targetPath) => ({
    targetPath,
    stagedPath: `${targetPath}.${transactionId}.staged`,
    backupPath: `${targetPath}.${transactionId}.backup`,
  }));
  const manifestPath = manifestPathForRoot(rootPath);
  const staging: ChainRewriteManifest = {
    version: 1,
    transactionId,
    phase: 'staging',
    rootPath,
    files,
  };

  try {
    // Publish the recovery record before creating any artifact. This keeps
    // pre-redaction backups discoverable after SIGKILL or power loss.
    writeManifestDurable(manifestPath, staging);
    params.onDurablePhase?.('staging');
    params.renewLease?.();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      params.writeEntries(file.stagedPath, params.entriesByTarget[index]!);
      syncFile(file.stagedPath);
      params.renewLease?.();
      copyFileSync(file.targetPath, file.backupPath);
      syncFile(file.backupPath);
      params.renewLease?.();
    }
    syncDirectory(rootDir);
    const changedTarget = params.targetPaths.find((targetPath, index) => (
      fingerprintTarget(targetPath) !== originalFingerprints[index]
    ));
    if (changedTarget) {
      throw new Error(`L0 chain changed while staging rewrite: ${changedTarget}`);
    }
    const prepared = { ...staging, phase: 'prepared' } satisfies ChainRewriteManifest;
    writeManifestDurable(manifestPath, prepared);
    params.onDurablePhase?.('prepared');
    params.renewLease?.();

    for (const file of files) {
      renameSync(file.stagedPath, file.targetPath);
      params.renewLease?.();
    }
    syncDirectory(rootDir);
    writeManifestDurable(manifestPath, { ...prepared, phase: 'committed' });
    params.onDurablePhase?.('committed');
    params.renewLease?.();
    try {
      cleanTransactionFiles(manifestPath, { ...prepared, phase: 'committed' });
    } catch {
      // The committed manifest is a durable cleanup record. Returning success
      // lets callers install their post-rewrite tail fence; startup recovery
      // will finish cleanup before the chain can be read or appended again.
    }
  } catch (error) {
    if (existsSync(manifestPath)) {
      try {
        const committed = parseManifest(manifestPath).phase === 'committed';
        recoverJournalChainRewrite(rootPath);
        if (committed) return;
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `L0 chain rewrite failed and rollback also failed for ${basename(rootPath)}`,
        );
      }
    }
    throw error;
  }
}

export function pendingJournalChainRewriteManifestPath(rootPath: string): string {
  return manifestPathForRoot(rootPath);
}
