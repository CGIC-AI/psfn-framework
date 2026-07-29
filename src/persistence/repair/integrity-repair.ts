import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  parseJournalText,
  resolveJournalIntegrityChainCandidates,
  signJournalEntry,
  verifyJournalEntryIntegrity,
} from '../journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { primeChannelIndexFromDisk } from '../sessions/store/channel-index.js';
import { discoverSessionFileChains } from '../sessions/store/session-file-chains.js';
import { withSessionJournalWriteLock } from '../sessions/store/session-journal-write-lock.js';
import { CHANNEL_INDEX_FILENAME } from '../sessions/store-primitives.js';

export interface SessionIntegrityRepairCounts {
  scannedFiles: number;
  modifiedFiles: number;
  modifiedEntries: number;
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

interface RepairParams {
  sessionsDir: string;
  backupDir: string;
  keyring: SessionHmacKeyring;
  repoRoot: string;
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

function ensureBackup(filePath: string, backupDir: string, repoRoot: string): void {
  const backupPath = join(backupDir, relative(repoRoot, filePath));
  if (existsSync(backupPath)) return;
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
}

function rewriteJournalChainUnderLock(
  filePaths: readonly string[],
  keyring: SessionHmacKeyring,
  backupDir: string,
  repoRoot: string,
  archivePort: ReturnType<typeof createFilesystemSessionArchivePort>,
  renewLease: () => void,
): { modifiedEntries: number; modifiedFiles: number } {
  const originalEntriesByFile = filePaths.map((filePath) => {
    const parsed = parseJournalText(readFileSync(filePath, 'utf-8'));
    renewLease();
    if (parsed.quarantined.length > 0) {
      throw new Error(`Refusing to rewrite malformed journal file: ${filePath}`);
    }
    return parsed.entries;
  });
  let modifiedEntries = 0;
  let previousHmacCandidates: Array<string | null> = [null];
  for (const entries of originalEntriesByFile) {
    for (const entry of entries) {
      renewLease();
      let verified = false;
      const candidateList = previousHmacCandidates.length > 0 ? previousHmacCandidates : [null];
      const nextCandidates: Array<string | null> = [];
      for (const previousHmac of candidateList) {
        const verification = verifyJournalEntryIntegrity(entry, keyring, previousHmac);
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
  if (modifiedEntries <= 0) return { modifiedEntries: 0, modifiedFiles: 0 };

  for (const filePath of filePaths) {
    ensureBackup(filePath, backupDir, repoRoot);
    renewLease();
  }

  let previousHmac: string | null = null;
  const rewrittenByFile = originalEntriesByFile.map(entries => entries.map((entry) => {
    renewLease();
    const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
    const signed = signJournalEntry(unsigned, keyring, previousHmac);
    previousHmac = signed._hmac ?? null;
    return signed;
  }));
  const firstEntry = originalEntriesByFile.find(entries => entries.length > 0)?.[0];
  if (!firstEntry) {
    throw new Error(`Cannot rewrite an empty L0 journal chain: ${filePaths[0]}`);
  }
  const archives = filePaths.map(filePath => archivePort.openArchive(
    firstEntry.channelId,
    filePath,
  ));
  archivePort.rewriteJournalChain(archives, rewrittenByFile, renewLease);
  return { modifiedEntries, modifiedFiles: filePaths.length };
}

function rewriteJournalChain(
  filePaths: readonly string[],
  keyring: SessionHmacKeyring,
  backupDir: string,
  repoRoot: string,
): { modifiedEntries: number; modifiedFiles: number } {
  const rootPath = filePaths[0];
  if (!rootPath) return { modifiedEntries: 0, modifiedFiles: 0 };
  const archivePort = createFilesystemSessionArchivePort();
  return withSessionJournalWriteLock(rootPath, (renewLease) => {
    archivePort.recoverJournalChainRewrite(rootPath);
    return rewriteJournalChainUnderLock(
      filePaths,
      keyring,
      backupDir,
      repoRoot,
      archivePort,
      renewLease,
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

  // Accumulators declared before the work so the audit record captures partial
  // progress even when a later chain aborts the run.
  const journalReport: SessionIntegrityRepairCounts = {
    scannedFiles: 0,
    modifiedFiles: 0,
    modifiedEntries: 0,
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
      rebuiltChannelIndex,
      ...extra,
    });
  };

  try {
    mkdirSync(params.backupDir, { recursive: true });

    const discovered = discoverSessionFileChains(params.sessionsDir);
    if (discovered.incompleteChains.length > 0) {
      throw new Error(`Refusing integrity repair with incomplete L0 chains: ${JSON.stringify(discovered.incompleteChains)}`);
    }
    for (const chain of discovered.chains) {
      if (chain.channelId) channelIds.add(chain.channelId);
    }
    journalReport.scannedFiles = discovered.chains.flatMap(chain => chain.filePaths).length;

    for (const chain of discovered.chains) {
      const modified = rewriteJournalChain(
        chain.filePaths,
        params.keyring,
        params.backupDir,
        params.repoRoot,
      );
      journalReport.modifiedFiles += modified.modifiedFiles;
      journalReport.modifiedEntries += modified.modifiedEntries;
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
