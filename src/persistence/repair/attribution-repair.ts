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
import type { TurnRecord, TurnRecordMessage } from '../../shared/contracts/runtime.js';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  parseJournalText,
  signJournalEntry,
} from '../journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { normalizeSessionEntryAttribution } from '../../core/session/entry-attribution.js';
import type { JournalEntry } from '../../core/session/types.js';
import { primeChannelIndexFromDisk } from '../sessions/store/channel-index.js';
import { discoverSessionFileChains } from '../sessions/store/session-file-chains.js';
import { withSessionJournalWriteLock } from '../sessions/store/session-journal-write-lock.js';
import { CHANNEL_INDEX_FILENAME } from '../sessions/store-primitives.js';

const INTENTION_AUTHOR_ID = 'system:intention';
const INTENTION_AUTHOR_NAME = 'Intention Appraisal';
const SCHEDULER_AUTHOR_ID = 'scheduler';
const TURN_RECORDS_DIR = '_turn_records';

export interface AttributionRepairCounts {
  scannedFiles: number;
  modifiedFiles: number;
  modifiedEntries: number;
}

export interface AttributionRepairReport {
  backupsDir: string;
  journal: AttributionRepairCounts;
  turnRecords: AttributionRepairCounts;
  rebuiltChannelIndex: boolean;
}

interface RepairPaths {
  sessionsDir: string;
  continuityDir: string;
  reflectionsDir: string;
  backupDir: string;
}

function parseMetadataObject(metadata: string | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serializeMetadataObject(value: Record<string, unknown> | null, fallback: string | undefined): string | undefined {
  if (!value) return fallback;
  return JSON.stringify(value);
}

function deriveSystemAuthorId(entry: {
  channelId: string;
  authorId?: string;
  authorName?: string;
  content: string;
  metadata?: string;
  requestId?: string;
  sourceMessageId?: string;
}): string | undefined {
  const authorId = entry.authorId?.trim();
  const authorName = entry.authorName?.trim();
  const content = entry.content.trimStart();
  const requestId = entry.requestId?.trim();
  const sourceMessageId = entry.sourceMessageId?.trim();

  const isIntention = (
    authorId?.startsWith('system:')
    || authorName === INTENTION_AUTHOR_NAME
    || requestId?.startsWith('intention-follow-up:')
    || sourceMessageId?.startsWith('intention-follow-up:')
    || content.startsWith('[Intention Appraisal]')
  );
  if (isIntention) return INTENTION_AUTHOR_ID;

  const isScheduledPrompt = (
    authorId === SCHEDULER_AUTHOR_ID
    || entry.channelId === 'internal:heartbeat'
    || entry.channelId.startsWith('internal:reflection:')
    || entry.channelId.startsWith('internal:planned:')
  );
  if (isScheduledPrompt) return SCHEDULER_AUTHOR_ID;

  return authorId;
}

function repairMetadataRole(metadata: string | undefined, role: 'user' | 'assistant' | 'system'): string | undefined {
  const parsed = parseMetadataObject(metadata);
  if (!parsed) return metadata;

  const turnValue = parsed.turn;
  if (!turnValue || typeof turnValue !== 'object' || Array.isArray(turnValue)) {
    return metadata;
  }

  const turn = turnValue as Record<string, unknown>;
  if (turn.role === role && turn.speakerRole === role) {
    return metadata;
  }

  turn.role = role;
  turn.speakerRole = role;
  parsed.turn = turn;
  return serializeMetadataObject(parsed, metadata);
}

function repairJournalEntry(entry: JournalEntry): { entry: JournalEntry; modified: boolean } {
  if (entry.type !== 'message' || typeof entry.content !== 'string' || typeof entry.role !== 'string') {
    return { entry, modified: false };
  }

  const metadataObject = parseMetadataObject(entry.metadata);
  const turnValue = metadataObject?.turn;
  const turn = turnValue && typeof turnValue === 'object' && !Array.isArray(turnValue)
    ? turnValue as Record<string, unknown>
    : null;
  const requestId = typeof turn?.requestId === 'string' ? turn.requestId : undefined;
  const sourceMessageId = typeof turn?.sourceMessageId === 'string' ? turn.sourceMessageId : undefined;

  const normalized = normalizeSessionEntryAttribution({
    role: entry.role,
    content: entry.content,
    authorId: entry.authorId,
    authorName: entry.authorName,
    metadata: entry.metadata,
    channelId: entry.channelId,
    requestId,
    sourceMessageId,
  });
  const nextRole = normalized.role === 'tool' ? entry.role : normalized.role;
  const nextAuthorId = normalized.role === 'system'
    ? deriveSystemAuthorId({
      channelId: entry.channelId,
      authorId: entry.authorId,
      authorName: entry.authorName,
      content: entry.content,
      metadata: entry.metadata,
      requestId,
      sourceMessageId,
    })
    : entry.authorId;
  const nextAuthorName = normalized.authorName ?? entry.authorName;
  const nextMetadata = nextRole === 'system' || nextRole === 'assistant' || nextRole === 'user'
    ? repairMetadataRole(entry.metadata, nextRole)
    : entry.metadata;

  const modified = (
    nextRole !== entry.role
    || nextAuthorId !== entry.authorId
    || nextAuthorName !== entry.authorName
    || nextMetadata !== entry.metadata
  );
  if (!modified) {
    return { entry, modified: false };
  }

  return {
    modified: true,
    entry: {
      ...entry,
      role: nextRole,
      authorId: nextAuthorId,
      authorName: nextAuthorName,
      metadata: nextMetadata,
    },
  };
}

function repairTurnRecordMessage(
  message: TurnRecordMessage,
  context: { channelId: string; requestId: string },
): { message: TurnRecordMessage; modified: boolean } {
  const normalized = normalizeSessionEntryAttribution({
    role: message.role,
    content: message.content,
    authorId: message.authorId,
    authorName: message.authorName,
    channelId: context.channelId,
    requestId: context.requestId,
    sourceMessageId: message.sourceMessageId,
  });
  const nextRole = normalized.role === 'tool' ? message.role : normalized.role;
  const nextAuthorId = normalized.role === 'system'
    ? deriveSystemAuthorId({
      channelId: context.channelId,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      requestId: context.requestId,
      sourceMessageId: message.sourceMessageId,
    })
    : message.authorId;
  const nextAuthorName = normalized.authorName ?? message.authorName;
  const modified = (
    nextRole !== message.role
    || nextAuthorId !== message.authorId
    || nextAuthorName !== message.authorName
  );
  if (!modified) {
    return { message, modified: false };
  }

  return {
    modified: true,
    message: {
      ...message,
      role: nextRole,
      authorId: nextAuthorId,
      authorName: nextAuthorName,
    },
  };
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

function rewriteJournalChainUnderLock(
  filePaths: readonly string[],
  keyring: SessionHmacKeyring | null,
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
  const hasIntegrity = originalEntriesByFile.some(entries => entries.some(entry => (
    typeof entry._hmac === 'string' || typeof entry._hmacKeyVersion === 'string'
  )));
  if (hasIntegrity && !keyring) {
    throw new Error(`Cannot rewrite signed journal chain without HMAC keyring: ${filePaths[0]}`);
  }

  let modifiedEntries = 0;
  const repairedEntriesByFile = originalEntriesByFile.map(entries => entries.map((entry) => {
    renewLease();
    const repaired = repairJournalEntry(entry);
    if (repaired.modified) modifiedEntries += 1;
    return repaired.entry;
  }));
  if (modifiedEntries === 0) return { modifiedEntries: 0, modifiedFiles: 0 };

  for (const filePath of filePaths) {
    ensureBackup(filePath, backupDir, repoRoot);
    renewLease();
  }

  let previousHmac: string | null = null;
  const rewrittenByFile = repairedEntriesByFile.map(entries => entries.map((entry) => {
      renewLease();
      const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
      if (!hasIntegrity) return unsigned;
      const signed = signJournalEntry(unsigned, keyring!, previousHmac);
      previousHmac = signed._hmac ?? null;
      return signed;
    }));
  const firstEntry = originalEntriesByFile.find(entries => entries.length > 0)?.[0];
  const archives = filePaths.map(filePath => archivePort.openArchive(firstEntry?.channelId ?? 'unknown', filePath));
  archivePort.rewriteJournalChain(archives, rewrittenByFile, renewLease);
  return { modifiedEntries, modifiedFiles: filePaths.length };
}

function rewriteJournalChain(
  filePaths: readonly string[],
  keyring: SessionHmacKeyring | null,
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

function rewriteTurnRecordFile(filePath: string, backupDir: string, repoRoot: string): number {
  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 0;

  let modifiedRecords = 0;
  const rewritten = lines.map((line) => {
    const parsed = JSON.parse(line) as TurnRecord;
    const repairedUser = repairTurnRecordMessage(parsed.userMessage, {
      channelId: parsed.channelId,
      requestId: parsed.requestId,
    });
    const repairedAssistant = parsed.assistantMessage
      ? repairTurnRecordMessage(parsed.assistantMessage, {
        channelId: parsed.channelId,
        requestId: parsed.requestId,
      })
      : null;
    const modified = repairedUser.modified || (repairedAssistant?.modified ?? false);
    if (modified) modifiedRecords += 1;
    if (!modified) return parsed;

    return {
      ...parsed,
      userMessage: repairedUser.message,
      ...(repairedAssistant ? { assistantMessage: repairedAssistant.message } : {}),
    } satisfies TurnRecord;
  });

  if (modifiedRecords === 0) return 0;

  ensureBackup(filePath, backupDir, repoRoot);
  writeTextAtomic(filePath, `${rewritten.map(item => JSON.stringify(item)).join('\n')}\n`);
  return modifiedRecords;
}

function rebuildSessionChannelIndex(sessionsDir: string): void {
  primeChannelIndexFromDisk({
    sessionsDir,
    channelIndexPath: join(sessionsDir, CHANNEL_INDEX_FILENAME),
    channelIndex: new Map(),
    warnAboutQuarantinedEntries: () => {},
  });
}

function collectJsonlFiles(
  dirPath: string,
  options: { excludeSubdirs?: string[]; excludeFiles?: string[] } = {},
): string[] {
  if (!existsSync(dirPath)) return [];
  const excluded = new Set(options.excludeSubdirs ?? []);
  const excludedFiles = new Set(options.excludeFiles ?? []);
  const files: string[] = [];
  for (const name of readdirSync(dirPath)) {
    if (excluded.has(name)) continue;
    if (excludedFiles.has(name)) continue;
    const filePath = join(dirPath, name);
    if (name.endsWith('.jsonl')) {
      files.push(filePath);
    }
  }
  return files.sort();
}

export function runAttributionRepair(
  params: RepairPaths & { keyring: SessionHmacKeyring | null; repoRoot: string },
): AttributionRepairReport {
  mkdirSync(params.backupDir, { recursive: true });

  const discoveredSessions = discoverSessionFileChains(params.sessionsDir);
  if (discoveredSessions.incompleteChains.length > 0) {
    throw new Error(
      `Refusing attribution repair with incomplete L0 chains: ${JSON.stringify(discoveredSessions.incompleteChains)}`,
    );
  }
  const journalChains = [
    ...discoveredSessions.chains.map(chain => chain.filePaths),
    ...collectJsonlFiles(params.continuityDir).map(filePath => [filePath]),
    ...collectJsonlFiles(params.reflectionsDir, { excludeFiles: ['journal.jsonl'] }).map(filePath => [filePath]),
  ];
  const journalFiles = journalChains.flat();
  const turnRecordFiles = collectJsonlFiles(join(params.sessionsDir, TURN_RECORDS_DIR));

  const journalReport: AttributionRepairCounts = {
    scannedFiles: journalFiles.length,
    modifiedFiles: 0,
    modifiedEntries: 0,
  };
  for (const filePaths of journalChains) {
    const modified = rewriteJournalChain(filePaths, params.keyring, params.backupDir, params.repoRoot);
    journalReport.modifiedFiles += modified.modifiedFiles;
    journalReport.modifiedEntries += modified.modifiedEntries;
  }

  const turnRecordReport: AttributionRepairCounts = {
    scannedFiles: turnRecordFiles.length,
    modifiedFiles: 0,
    modifiedEntries: 0,
  };
  for (const filePath of turnRecordFiles) {
    const modifiedRecords = rewriteTurnRecordFile(filePath, params.backupDir, params.repoRoot);
    if (modifiedRecords <= 0) continue;
    turnRecordReport.modifiedFiles += 1;
    turnRecordReport.modifiedEntries += modifiedRecords;
  }

  rebuildSessionChannelIndex(params.sessionsDir);

  return {
    backupsDir: params.backupDir,
    journal: journalReport,
    turnRecords: turnRecordReport,
    rebuiltChannelIndex: true,
  };
}
