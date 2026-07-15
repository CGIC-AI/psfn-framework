import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

interface RepairParams {
  sessionsDir: string;
  backupDir: string;
  keyring: SessionHmacKeyring;
  repoRoot: string;
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
  mkdirSync(params.backupDir, { recursive: true });

  const discovered = discoverSessionFileChains(params.sessionsDir);
  if (discovered.incompleteChains.length > 0) {
    throw new Error(`Refusing integrity repair with incomplete L0 chains: ${JSON.stringify(discovered.incompleteChains)}`);
  }
  const journalFiles = discovered.chains.flatMap(chain => chain.filePaths);

  const journalReport: SessionIntegrityRepairCounts = {
    scannedFiles: journalFiles.length,
    modifiedFiles: 0,
    modifiedEntries: 0,
  };

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

  return {
    backupsDir: params.backupDir,
    journal: journalReport,
    rebuiltChannelIndex: true,
  };
}
