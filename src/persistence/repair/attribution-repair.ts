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
import { normalizeSessionEntryAttribution } from '../../core/session/entry-attribution.js';
import { primeChannelIndexFromDisk } from '../sessions/store/channel-index.js';
import { CHANNEL_INDEX_FILENAME } from '../sessions/store-primitives.js';

// Attribution repair corrects the DERIVED surfaces only. The canonical L0
// session chains are append-only history and are never rewritten here (Charter
// Law 2 / 6.20 L0 append-only, 7.5 repair must not rewrite canonical) — the
// runtime already normalizes role/author at read time
// (`normalizeSessionEntryAttribution`, see src/core/session/manager/context-support.ts
// and src/core/intention/appraisal/formatting.ts), so canonical entries present
// with correct attribution without mutating the sealed bytes. This tool rebuilds
// the derived `_turn_records` mirror and the derived channel index, mirroring the
// sanctioned transcript-projection-repair pattern (rebuild derived state FROM
// canon, never rewrite canon).

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
  turnRecords: AttributionRepairCounts;
  rebuiltChannelIndex: boolean;
}

interface RepairPaths {
  sessionsDir: string;
  backupDir: string;
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

function collectJsonlFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dirPath)) {
    if (name.endsWith('.jsonl')) {
      files.push(join(dirPath, name));
    }
  }
  return files.sort();
}

export function runAttributionRepair(
  params: RepairPaths & { repoRoot: string },
): AttributionRepairReport {
  mkdirSync(params.backupDir, { recursive: true });

  const turnRecordFiles = collectJsonlFiles(join(params.sessionsDir, TURN_RECORDS_DIR));
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
    turnRecords: turnRecordReport,
    rebuiltChannelIndex: true,
  };
}
