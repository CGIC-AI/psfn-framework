import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  parseJournalText,
  resolveJournalIntegrityChainCandidates,
} from '../journals/journal-utils.js';
import {
  createKeyringIntegrityProvider,
  type SessionIntegrityProvider,
} from '../sessions/store-primitives.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import type { QuarantinedJournalEntry } from '../journals/journal/types.js';
import { primeChannelIndexFromDisk } from '../sessions/store/channel-index.js';
import { discoverSessionFileChains } from '../sessions/store/session-file-chains.js';
import { fingerprintJournalArchiveGeneration } from '../sessions/store/journal-chain-runtime.js';
import { withSessionJournalWriteLock } from '../sessions/store/session-journal-write-lock.js';
import { CHANNEL_INDEX_FILENAME } from '../sessions/store-primitives.js';

export interface SessionIntegrityRepairCounts {
  scannedFiles: number;
  modifiedFiles: number;
  modifiedEntries: number;
  /**
   * Malformed (unparseable) journal rows quarantined out of the L0 chain during
   * the run. These rows are not canonical entries — no id, no authorship, no
   * HMAC linkage — so removing them preserves the integrity of every valid
   * entry while giving background-work handoff recovery a clean authority scan.
   */
  quarantinedRows: number;
}

export interface SessionIntegrityRepairReport {
  backupsDir: string;
  journal: SessionIntegrityRepairCounts;
  rebuiltChannelIndex: boolean;
}

/**
 * Minimal append-only audit sink for integrity-repair runs. Structurally
 * satisfied by {@link import('../../system/capabilities/safeguards.js').SafeguardAuditTrail};
 * kept as a narrow local interface so the repair module does not depend on the
 * capabilities layer and so tests can inject a fake without the filesystem.
 */
export interface SessionIntegrityRepairAuditSink {
  append(event: string, details: Record<string, unknown>): void;
}

/**
 * Structured audit event name for an integrity-repair run. Emitted to the
 * safeguard audit trail (operator-visible in Garden) so a sanctioned re-sign of
 * the L0 HMAC chain is durably traceable — when it ran, why, over which
 * channels, how many entries were re-sealed, and whether it succeeded. The
 * record is content-free: only structural counts, channel identifiers, the
 * operator's reason, and an outcome — never message text.
 */
export const SESSION_INTEGRITY_REPAIR_AUDIT_EVENT = 'session_integrity_repair';

export interface SessionIntegrityRepairJournalTarget {
  /** Trusted physical channel identity, separate from any routed logical owner. */
  channelId: string;
  /** Exact discovered L0 file chain selected for repair. */
  filePaths: readonly string[];
  /** Content-free generation identity that must still match under the write lock. */
  expectedArchiveFingerprint: string;
}

interface RepairParamsBase {
  sessionsDir: string;
  backupDir: string;
  /**
   * Optional exact channel allowlist for a bounded repair. `undefined` retains
   * the existing all-channel maintenance mode; an explicitly empty or
   * unresolved set fails closed so an operator typo can never widen a targeted
   * background-work recovery repair to every session journal.
   */
  targetChannelIds?: readonly string[];
  /**
   * Exact-chain mode for an evidence-bound automatic repair. Mutually exclusive
   * with `targetChannelIds`; unlike the channel allowlist it cannot widen to a
   * sibling session chain owned by the same physical channel.
   */
  targetJournalChain?: SessionIntegrityRepairJournalTarget;
  /**
   * Required operator reason for this run (fail closed on blank). Recorded in
   * the durable audit event so every re-sign carries its justification.
   */
  reason: string;
  /**
   * Optional durable audit sink. Real runs (the CLI) always wire the safeguard
   * audit trail; tests that only assert byte-unchanged repair behavior may omit
   * it. When present, exactly one record is emitted per run — on success and on
   * failure alike (attempt + outcome).
   */
  audit?: SessionIntegrityRepairAuditSink;
}

type RepairParams = RepairParamsBase & (
  | { keyring: SessionHmacKeyring; integrityProvider?: never }
  | { integrityProvider: SessionIntegrityProvider; keyring?: never }
);

function normalizeTargetChannelIds(
  targetChannelIds: readonly string[] | undefined,
): Set<string> | null {
  if (targetChannelIds === undefined) return null;
  const normalized = targetChannelIds.map(channelId => channelId.trim());
  if (normalized.length === 0 || normalized.some(channelId => channelId.length === 0)) {
    throw new Error('Target channel ids must contain at least one non-empty channel id');
  }
  return new Set(normalized);
}

interface NormalizedSessionIntegrityRepairJournalTarget {
  channelId: string;
  filePaths: readonly string[];
  expectedArchiveFingerprint: string;
}

function normalizeTargetJournalChain(
  target: SessionIntegrityRepairJournalTarget | undefined,
): NormalizedSessionIntegrityRepairJournalTarget | null {
  if (!target) return null;
  const channelId = target.channelId.trim();
  if (
    !channelId
    || target.filePaths.length === 0
    || target.filePaths.some(path => typeof path !== 'string' || path.trim().length === 0)
  ) {
    throw new Error('Exact journal target must contain a physical channel and file chain');
  }
  const filePaths = target.filePaths.map(path => resolve(path));
  if (new Set(filePaths).size !== filePaths.length) {
    throw new Error('Exact journal target must not contain duplicate archive paths');
  }
  if (!/^[a-f0-9]{64}$/u.test(target.expectedArchiveFingerprint)) {
    throw new Error('Exact journal target must contain a valid archive fingerprint');
  }
  return {
    channelId,
    filePaths,
    expectedArchiveFingerprint: target.expectedArchiveFingerprint,
  };
}

function hasExactFileChain(
  actualPaths: readonly string[],
  expectedPaths: readonly string[],
): boolean {
  return actualPaths.length === expectedPaths.length
    && actualPaths.every((path, index) => resolve(path) === expectedPaths[index]);
}

function staleJournalTargetError(cause?: unknown): NodeJS.ErrnoException {
  const error = new Error(
    'Exact journal repair target changed before mutation',
    cause === undefined ? undefined : { cause },
  ) as NodeJS.ErrnoException;
  error.name = 'SessionIntegrityRepairTargetChangedError';
  error.code = 'ESTALE';
  return error;
}

function syncFileDurable(filePath: string): void {
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectoryDurable(dirPath: string): void {
  const descriptor = openSync(dirPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Create a directory (if needed) and fsync it and its parent. */
function mkdirDurable(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
  syncDirectoryDurable(dirPath);
  syncDirectoryDurable(dirname(dirPath));
}

function writeLineFully(descriptor: number, line: string): void {
  const buffer = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
  }
}

/** Append one JSON line fully and fsync it (and the directory on first creation). */
function appendJsonLineDurable(filePath: string, entry: unknown): void {
  const created = !existsSync(filePath);
  const descriptor = openSync(filePath, 'a');
  try {
    writeLineFully(descriptor, `${JSON.stringify(entry)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (created) syncDirectoryDurable(dirname(filePath));
}

/**
 * Containment-checked backup location for a journal file. The backup namespace
 * is rooted at the sessions data root — the one authority guaranteed to contain
 * every discovered chain file — never at process.cwd(): a sessions root outside
 * the checkout must not escape backupDir through `..` segments. Fail closed on
 * any file that is not strictly inside the sessions root.
 */
export function resolveJournalBackupPath(
  backupDir: string,
  sessionsDir: string,
  filePath: string,
): string {
  const relativePath = relative(resolve(sessionsDir), resolve(filePath));
  if (
    relativePath.length === 0
    || relativePath.startsWith('..')
    || isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to back up a journal outside the sessions data root: ${filePath}`);
  }
  const resolvedBackupDir = resolve(backupDir);
  const backupPath = resolve(resolvedBackupDir, relativePath);
  if (!backupPath.startsWith(`${resolvedBackupDir}${sep}`)) {
    throw new Error(`Refusing to back up a journal outside the backup directory: ${filePath}`);
  }
  return backupPath;
}

/**
 * Raw pre-repair copy, fsync-durable before any destructive rewrite begins.
 * Fail closed twice over: the source must be a regular file (a symlink could
 * resolve lexically inside the sessions root while its bytes live outside),
 * and the backup must not already exist — silently trusting a pre-existing
 * collision would let a stale or planted file masquerade as the raw evidence
 * the receipt points at. The copy is exclusive, so a same-instant race loses
 * loudly instead of winning.
 */
function ensureBackup(filePath: string, backupDir: string, sessionsDir: string): string {
  if (!lstatSync(filePath).isFile()) {
    throw new Error(`Refusing to back up a non-regular journal file: ${filePath}`);
  }
  const backupPath = resolveJournalBackupPath(backupDir, sessionsDir, filePath);
  if (existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite a pre-existing journal backup: ${backupPath}`);
  }
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath, constants.COPYFILE_EXCL);
  syncFileDurable(backupPath);
  syncDirectoryDurable(dirname(backupPath));
  return backupPath;
}

/**
 * Durable, append-only quarantine disposition ledger for malformed rows a
 * repair run removes from the L0 chain. Lives in the run's timestamped backup
 * directory (alongside the full pre-repair file copies, which preserve the raw
 * bytes) so the disposition survives even after the in-place `.quarantine`
 * sidecars are cleaned up by later canonical reads. Every record is
 * content-free: line number, byte length, a stable reason code, and safe
 * sessions-root/backup-relative identifiers — never row bytes, message text,
 * or parser/error strings (Node JSON.parse errors can echo the raw data).
 *
 * Two-phase protocol: `prepared` rows are fsync-durable BEFORE any malformed
 * row can disappear from the chain; `completed` (or `aborted`) is appended
 * after the rewrite transaction resolves. A ledger with `prepared` rows and no
 * terminal record means the disposition was interrupted — the raw bytes remain
 * recoverable from the referenced backup file.
 */
export const SESSION_INTEGRITY_REPAIR_QUARANTINE_RECEIPTS_FILENAME = 'quarantine-receipts.jsonl';

export type SessionQuarantineDispositionPhase = 'prepared' | 'completed' | 'aborted';

/** Stable content-free classification of a malformed journal row. */
export type SessionQuarantineMalformedReason = 'invalid_json' | 'invalid_journal_entry';

/** Stable content-free failure code recorded when a rewrite aborts. */
export const SESSION_QUARANTINE_ABORT_FAILURE_CODE = 'rewrite_transaction_failed';

function classifyMalformedRow(raw: string): SessionQuarantineMalformedReason {
  try {
    JSON.parse(raw);
  } catch {
    return 'invalid_json';
  }
  return 'invalid_journal_entry';
}

let quarantineDispositionCounter = 0;

function nextQuarantineDispositionId(): string {
  quarantineDispositionCounter += 1;
  return `${process.pid}-${Date.now()}-${quarantineDispositionCounter}`;
}

function writePreparedQuarantineDisposition(
  backupDir: string,
  sessionsDir: string,
  dispositionId: string,
  rowsByFile: ReadonlyMap<string, readonly QuarantinedJournalEntry[]>,
): void {
  const receiptsPath = join(backupDir, SESSION_INTEGRITY_REPAIR_QUARANTINE_RECEIPTS_FILENAME);
  const recordedAt = Date.now();
  for (const [filePath, rows] of rowsByFile) {
    for (const row of rows) {
      appendJsonLineDurable(receiptsPath, {
        dispositionId,
        phase: 'prepared',
        recordedAt,
        file: relative(resolve(sessionsDir), resolve(filePath)),
        backupFile: relative(resolve(backupDir), resolveJournalBackupPath(backupDir, sessionsDir, filePath)),
        lineNumber: row.lineNumber,
        rawLength: row.raw.length,
        reason: classifyMalformedRow(row.raw),
      } satisfies Record<string, unknown>);
    }
  }
}

function writeTerminalQuarantineDisposition(
  backupDir: string,
  dispositionId: string,
  phase: 'completed' | 'aborted',
  rowCount: number,
  failureCode?: string,
): void {
  const receiptsPath = join(backupDir, SESSION_INTEGRITY_REPAIR_QUARANTINE_RECEIPTS_FILENAME);
  appendJsonLineDurable(receiptsPath, {
    dispositionId,
    phase,
    recordedAt: Date.now(),
    rowCount,
    ...(failureCode ? { failure: failureCode } : {}),
  });
}

function quarantineRowSignature(rows: readonly QuarantinedJournalEntry[]): string {
  return rows.map(row => `${row.lineNumber}:${row.raw.length}`).join(',');
}

/**
 * Exported for tests: the per-chain rewrite with the two-phase quarantine
 * disposition protocol. Production callers go through {@link runSessionIntegrityRepair}.
 */
export function rewriteJournalChainUnderLock(
  filePaths: readonly string[],
  keyring: SessionHmacKeyring,
  backupDir: string,
  sessionsDir: string,
  archivePort: ReturnType<typeof createFilesystemSessionArchivePort>,
  renewLease: () => void,
): { modifiedEntries: number; modifiedFiles: number; quarantinedRows: number } {
  const integrityProvider = createKeyringIntegrityProvider(keyring);
  if (!integrityProvider) {
    throw new Error('Session integrity repair requires an integrity provider');
  }
  return rewriteJournalChainUnderLockWithProvider(
    filePaths,
    integrityProvider,
    backupDir,
    sessionsDir,
    archivePort,
    renewLease,
  );
}

function rewriteJournalChainUnderLockWithProvider(
  filePaths: readonly string[],
  integrityProvider: SessionIntegrityProvider,
  backupDir: string,
  sessionsDir: string,
  archivePort: ReturnType<typeof createFilesystemSessionArchivePort>,
  renewLease: () => void,
  physicalChannelId?: string,
): { modifiedEntries: number; modifiedFiles: number; quarantinedRows: number } {
  const parsedByFile = filePaths.map((filePath) => {
    const parsed = parseJournalText(readFileSync(filePath, 'utf-8'));
    renewLease();
    return { filePath, entries: parsed.entries, quarantined: parsed.quarantined };
  });
  const originalEntriesByFile = parsedByFile.map(parsed => parsed.entries);
  const quarantinedRows = parsedByFile.reduce((total, parsed) => total + parsed.quarantined.length, 0);
  let modifiedEntries = 0;
  let previousHmacCandidates: Array<string | null> = [null];
  for (const entries of originalEntriesByFile) {
    for (const entry of entries) {
      renewLease();
      let verified = false;
      const candidateList = previousHmacCandidates.length > 0 ? previousHmacCandidates : [null];
      const nextCandidates: Array<string | null> = [];
      for (const previousHmac of candidateList) {
        const verification = integrityProvider.verify(entry, previousHmac);
        if (verification.verified) verified = true;
        for (const candidate of resolveJournalIntegrityChainCandidates(verification, previousHmac)) {
          if (!nextCandidates.some(existing => existing === candidate)) {
            nextCandidates.push(candidate);
          }
        }
      }
      if (!verified) modifiedEntries += 1;
      previousHmacCandidates = nextCandidates.length > 0 ? nextCandidates : [null];
    }
  }
  if (modifiedEntries <= 0 && quarantinedRows === 0) {
    return { modifiedEntries: 0, modifiedFiles: 0, quarantinedRows: 0 };
  }
  // Validate before any durable artifact is created: a chain with no parseable
  // entries cannot be rewritten at all.
  const firstEntry = originalEntriesByFile.find(entries => entries.length > 0)?.[0];
  if (!firstEntry) {
    throw new Error(`Cannot rewrite an empty L0 journal chain: ${filePaths[0]}`);
  }

  // (a) Full raw pre-repair backup: fsync-durable and containment-checked
  // before any malformed row can disappear.
  for (const { filePath } of parsedByFile) {
    ensureBackup(filePath, backupDir, sessionsDir);
    renewLease();
  }

  // (b) Content-free prepared disposition record: fsync-durable before the
  // rewrite transaction starts, so a crash mid-rewrite leaves a truthful
  // prepared-only ledger plus the raw backups.
  const dispositionId = quarantinedRows > 0 ? nextQuarantineDispositionId() : null;
  if (dispositionId) {
    writePreparedQuarantineDisposition(
      backupDir,
      sessionsDir,
      dispositionId,
      new Map(parsedByFile.map(parsed => [parsed.filePath, parsed.quarantined])),
    );
  }

  let previousHmac: string | null = null;
  const rewrittenByFile = originalEntriesByFile.map(entries => entries.map((entry) => {
    renewLease();
    if (modifiedEntries <= 0) {
      // Quarantine-only rewrite: every parseable entry already verifies, so the
      // original sealing is preserved exactly. Dropping unparseable rows cannot
      // break the chain — no entry's HMAC ever linked to them.
      return entry;
    }
    const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
    const signed = integrityProvider.sign(unsigned, previousHmac);
    previousHmac = signed._hmac ?? null;
    return signed;
  }));
  const archives = filePaths.map(filePath => archivePort.openArchive(
    physicalChannelId ?? firstEntry.channelId,
    filePath,
  ));
  // The chain-rewrite guard re-derives malformed rows from disk and hands them
  // back through this hook. Fail closed if they drifted from the rows the
  // prepared receipt covers — the ledger must always describe the bytes that
  // are actually dropped.
  const preparedSignatureByFile = new Map(parsedByFile.map(parsed => [
    resolve(parsed.filePath),
    quarantineRowSignature(parsed.quarantined),
  ]));
  try {
    archivePort.rewriteJournalChain(
      archives,
      rewrittenByFile,
      renewLease,
      (targetPath, quarantined) => {
        const expected = preparedSignatureByFile.get(targetPath) ?? '';
        if (quarantineRowSignature(quarantined) !== expected || expected.length === 0) {
          throw new Error(`L0 journal malformed rows changed during repair: ${targetPath}`);
        }
      },
    );
  } catch (error) {
    if (dispositionId) {
      // Content-free: a stable failure code, never the error text — arbitrary
      // error messages can echo the malformed row's raw bytes.
      writeTerminalQuarantineDisposition(
        backupDir,
        dispositionId,
        'aborted',
        quarantinedRows,
        SESSION_QUARANTINE_ABORT_FAILURE_CODE,
      );
    }
    throw error;
  }
  if (dispositionId) {
    writeTerminalQuarantineDisposition(backupDir, dispositionId, 'completed', quarantinedRows);
  }
  return { modifiedEntries, modifiedFiles: filePaths.length, quarantinedRows };
}

function rewriteJournalChain(
  filePaths: readonly string[],
  integrityProvider: SessionIntegrityProvider,
  backupDir: string,
  sessionsDir: string,
  exactTarget?: NormalizedSessionIntegrityRepairJournalTarget,
): { modifiedEntries: number; modifiedFiles: number; quarantinedRows: number } {
  const rootPath = filePaths[0];
  if (!rootPath) return { modifiedEntries: 0, modifiedFiles: 0, quarantinedRows: 0 };
  const archivePort = createFilesystemSessionArchivePort();
  return withSessionJournalWriteLock(rootPath, (renewLease) => {
    if (exactTarget) {
      let currentFingerprint: string | null;
      try {
        const archives = filePaths.map(filePath => (
          archivePort.openArchive(exactTarget.channelId, filePath)
        ));
        currentFingerprint = fingerprintJournalArchiveGeneration(archivePort, archives);
      } catch (error) {
        throw staleJournalTargetError(error);
      }
      if (currentFingerprint !== exactTarget.expectedArchiveFingerprint) {
        throw staleJournalTargetError();
      }
      renewLease();
    }
    archivePort.recoverJournalChainRewrite(rootPath);
    return rewriteJournalChainUnderLockWithProvider(
      filePaths,
      integrityProvider,
      backupDir,
      sessionsDir,
      archivePort,
      renewLease,
      exactTarget?.channelId,
    );
  });
}

function rebuildSessionChannelIndex(sessionsDir: string): void {
  primeChannelIndexFromDisk({
    sessionsDir,
    channelIndexPath: join(sessionsDir, CHANNEL_INDEX_FILENAME),
    channelIndex: new Map(),
    warnAboutQuarantinedEntries: () => {},
  });
}

export function runSessionIntegrityRepair(params: RepairParams): SessionIntegrityRepairReport {
  const reason = params.reason.trim();
  if (reason.length === 0) {
    // Fail closed: every sanctioned re-sign must carry an operator reason so the
    // durable audit record is never anonymous.
    throw new Error('Session integrity repair requires a non-empty operator reason');
  }
  const integrityProvider = 'integrityProvider' in params
    ? params.integrityProvider
    : createKeyringIntegrityProvider(params.keyring);
  if (!integrityProvider) {
    throw new Error('Session integrity repair requires an integrity provider');
  }
  const targetChannelIds = normalizeTargetChannelIds(params.targetChannelIds);
  const targetJournalChain = normalizeTargetJournalChain(params.targetJournalChain);
  if (targetChannelIds && targetJournalChain) {
    throw new Error('Session integrity repair accepts either channel targets or one exact chain');
  }

  // Accumulators declared before the work so the audit record captures partial
  // progress even when a later chain aborts the run.
  const journalReport: SessionIntegrityRepairCounts = {
    scannedFiles: 0,
    modifiedFiles: 0,
    modifiedEntries: 0,
    quarantinedRows: 0,
  };
  const channelIds = new Set<string>();
  let rebuiltChannelIndex = false;

  const emitAudit = (
    outcome: 'completed' | 'failed',
    extra: Record<string, unknown> = {},
  ): void => {
    if (!params.audit) return;
    params.audit.append(SESSION_INTEGRITY_REPAIR_AUDIT_EVENT, {
      reason,
      outcome,
      backupsDir: params.backupDir,
      channelIds: [...channelIds],
      scannedFiles: journalReport.scannedFiles,
      modifiedFiles: journalReport.modifiedFiles,
      modifiedEntries: journalReport.modifiedEntries,
      quarantinedRows: journalReport.quarantinedRows,
      rebuiltChannelIndex,
      ...(targetChannelIds ? { targetChannelIds: [...targetChannelIds] } : {}),
      ...(targetJournalChain ? {
        targetJournalChain: {
          channelId: targetJournalChain.channelId,
          fileCount: targetJournalChain.filePaths.length,
        },
      } : {}),
      ...extra,
    });
  };

  try {
    const discovered = discoverSessionFileChains(params.sessionsDir);
    const incompleteChains = targetJournalChain
      ? []
      : targetChannelIds
      ? discovered.incompleteChains.filter(chain => targetChannelIds.has(chain.channelId))
      : discovered.incompleteChains;
    if (incompleteChains.length > 0) {
      throw new Error(`Refusing integrity repair with incomplete L0 chains: ${JSON.stringify(incompleteChains)}`);
    }
    const repairChains = targetJournalChain
      ? discovered.chains.filter(chain => (
        chain.channelId === targetJournalChain.channelId
        && hasExactFileChain(chain.filePaths, targetJournalChain.filePaths)
      ))
      : targetChannelIds
      ? discovered.chains.filter(chain => targetChannelIds.has(chain.channelId))
      : discovered.chains;
    if (targetJournalChain && repairChains.length !== 1) {
      throw staleJournalTargetError();
    }
    if (targetChannelIds) {
      const resolvedChannelIds = new Set(repairChains.map(chain => chain.channelId));
      const missingChannelIds = [...targetChannelIds]
        .filter(channelId => !resolvedChannelIds.has(channelId));
      if (missingChannelIds.length > 0) {
        throw new Error(
          `Target channel ids have no complete L0 journal chain: ${missingChannelIds.join(', ')}`,
        );
      }
    }

    // The timestamped backup root is created once per validated run; make the
    // creation itself durable before any file beneath it is relied on as
    // evidence. Target validation happens first so a typo creates no repair
    // artifact and, critically, never falls back to an all-channel mutation.
    mkdirDurable(params.backupDir);

    for (const chain of repairChains) {
      if (chain.channelId) channelIds.add(chain.channelId);
    }
    journalReport.scannedFiles = repairChains.flatMap(chain => chain.filePaths).length;

    for (const chain of repairChains) {
      const modified = rewriteJournalChain(
        chain.filePaths,
        integrityProvider,
        params.backupDir,
        params.sessionsDir,
        targetJournalChain ?? undefined,
      );
      journalReport.modifiedFiles += modified.modifiedFiles;
      journalReport.modifiedEntries += modified.modifiedEntries;
      journalReport.quarantinedRows += modified.quarantinedRows;
    }

    rebuildSessionChannelIndex(params.sessionsDir);
    rebuiltChannelIndex = true;

    const report: SessionIntegrityRepairReport = {
      backupsDir: params.backupDir,
      journal: journalReport,
      rebuiltChannelIndex: true,
    };
    emitAudit('completed');
    return report;
  } catch (error) {
    // Record the attempt and its outcome even on partial failure, then rethrow;
    // the repair behavior is unchanged (the error still propagates to the CLI).
    emitAudit('failed', { errorMessage: toErrorMessage(error) });
    throw error;
  }
}
