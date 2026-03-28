import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  parseJournalText,
  readJournalFirstEntry,
  signJournalEntry,
  verifyJournalEntryIntegrity,
} from '../journals/journal-utils.js';
import { buildIndexEntry, saveChannelIndex } from '../sessions/store/channel-index.js';
import { isSessionJournalFilename } from '../sessions/store/channel-filenames.js';
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

function writeTextAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, filePath);
}

function rewriteJournalFile(
  filePath: string,
  keyring: SessionHmacKeyring,
  backupDir: string,
  repoRoot: string,
): number {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseJournalText(raw);
  if (parsed.quarantined.length > 0) {
    throw new Error(`Refusing to rewrite malformed journal file: ${filePath}`);
  }

  const originalEntries = parsed.entries;
  let modifiedEntries = 0;
  let previousObservedHmac: string | null = null;
  for (const entry of originalEntries) {
    const verification = verifyJournalEntryIntegrity(entry, keyring, previousObservedHmac);
    if (!verification.verified) {
      modifiedEntries += 1;
    }
    if (typeof entry._hmac === 'string') {
      previousObservedHmac = entry._hmac;
    }
  }
  if (modifiedEntries <= 0) return 0;

  ensureBackup(filePath, backupDir, repoRoot);

  let previousHmac: string | null = null;
  const rewritten = originalEntries.map((entry) => {
    const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
    const signed = signJournalEntry(unsigned, keyring, previousHmac);
    previousHmac = signed._hmac ?? null;
    return signed;
  });

  writeTextAtomic(filePath, `${rewritten.map(item => JSON.stringify(item)).join('\n')}\n`);
  return modifiedEntries;
}

function rebuildSessionChannelIndex(sessionsDir: string): void {
  const channelIndex = new Map<string, ReturnType<typeof buildIndexEntry>>();
  const warnAboutQuarantinedEntries = () => {};

  for (const filename of readdirSync(sessionsDir).sort()) {
    if (!isSessionJournalFilename(filename)) continue;
    const filePath = join(sessionsDir, filename);
    const channelId = readJournalFirstEntry(filePath)?.channelId;
    if (!channelId) continue;
    const entry = buildIndexEntry(channelId, filePath, warnAboutQuarantinedEntries);
    channelIndex.set(channelId, entry);
  }

  saveChannelIndex(join(sessionsDir, CHANNEL_INDEX_FILENAME), channelIndex);
}

export function runSessionIntegrityRepair(params: RepairParams): SessionIntegrityRepairReport {
  mkdirSync(params.backupDir, { recursive: true });

  const journalFiles = readdirSync(params.sessionsDir)
    .filter(isSessionJournalFilename)
    .sort()
    .map(filename => join(params.sessionsDir, filename));

  const journalReport: SessionIntegrityRepairCounts = {
    scannedFiles: journalFiles.length,
    modifiedFiles: 0,
    modifiedEntries: 0,
  };

  for (const filePath of journalFiles) {
    const modifiedEntries = rewriteJournalFile(filePath, params.keyring, params.backupDir, params.repoRoot);
    if (modifiedEntries <= 0) continue;
    journalReport.modifiedFiles += 1;
    journalReport.modifiedEntries += modifiedEntries;
  }

  rebuildSessionChannelIndex(params.sessionsDir);

  return {
    backupsDir: params.backupDir,
    journal: journalReport,
    rebuiltChannelIndex: true,
  };
}
