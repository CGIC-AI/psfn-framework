import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  repairLegacyTurnRecordBackgroundWorkHandoffForRecovery,
} from '../../core/agent/background-work/types.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  normalizeTurnRecord,
  withTurnRecordRotationLock,
} from '../sessions/turn-records.js';

const TURN_RECORDS_DIR = '_turn_records';
const SEALED_SEGMENT_SUFFIX = /\.\d{5,}\.jsonl$/u;

interface PlannedFileRewrite {
  filePath: string;
  rewrittenContent: string;
  retiredJobs: number;
  repairedRecords: number;
}

export interface LegacyTurnRecordBackgroundWorkMigrationReport {
  filesModified: number;
  filesScanned: number;
  mode: 'apply' | 'dry-run';
  recordsRepaired: number;
  remainingLegacyJobs: number;
  retiredLegacyJobs: number;
  sessionsDir: string;
}

function collectTurnRecordFiles(sessionsDir: string): string[] {
  const turnRecordsDir = join(sessionsDir, TURN_RECORDS_DIR);
  if (!existsSync(turnRecordsDir)) return [];
  return readdirSync(turnRecordsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(turnRecordsDir, entry.name))
    .sort();
}

function activeSegmentPath(filePath: string): string {
  return SEALED_SEGMENT_SUFFIX.test(filePath)
    ? filePath.replace(SEALED_SEGMENT_SUFFIX, '.jsonl')
    : filePath;
}

function parseAndRepairFile(filePath: string): PlannedFileRewrite | null {
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  let retiredJobs = 0;
  let repairedRecords = 0;
  const rewrittenLines = lines.map((line, index) => {
    if (line.trim().length === 0) return line;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid TurnRecord JSON in ${filePath}:${index + 1}: ${String(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(raw) || typeof raw.channelId !== 'string' || raw.channelId.trim().length === 0) {
      throw new Error(`TurnRecord in ${filePath}:${index + 1} has no valid channelId`);
    }
    let record;
    try {
      record = normalizeTurnRecord(raw, raw.channelId);
    } catch (error) {
      throw new Error(
        `Invalid TurnRecord in ${filePath}:${index + 1}: ${String(error)}`,
        { cause: error },
      );
    }
    if (record.status !== 'completed' || !record.backgroundWorkHandoff) return line;
    const repair = repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record);
    if (repair.retiredLegacyEmotionAppraisalJobs === 0) return line;
    retiredJobs += repair.retiredLegacyEmotionAppraisalJobs;
    repairedRecords += 1;
    return JSON.stringify(repair.record);
  });
  if (retiredJobs === 0) return null;
  return {
    filePath,
    rewrittenContent: rewrittenLines.join('\n'),
    retiredJobs,
    repairedRecords,
  };
}

function copyBackup(filePath: string, backupDir: string): void {
  const backupPath = join(backupDir, basename(filePath));
  if (existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite existing TurnRecord backup: ${backupPath}`);
  }
  copyFileSync(filePath, backupPath);
}

function assertEmptyBackupTarget(backupDir: string): void {
  mkdirSync(backupDir, { recursive: true });
  const occupants = readdirSync(backupDir);
  if (occupants.length > 0) {
    throw new Error(`TurnRecord migration backup directory must be empty: ${backupDir}`);
  }
}

function rewriteAtomically(rewrite: PlannedFileRewrite, backupDir: string): void {
  withTurnRecordRotationLock(activeSegmentPath(rewrite.filePath), () => {
    // Re-plan beneath the same lock. A process may have appended or rotated
    // after the dry plan, and applying bytes from that stale view would lose it.
    const current = parseAndRepairFile(rewrite.filePath);
    if (!current) return;
    copyBackup(rewrite.filePath, backupDir);
    const tempPath = join(
      dirname(rewrite.filePath),
      `.${basename(rewrite.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    writeFileSync(tempPath, current.rewrittenContent, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, rewrite.filePath);
  });
}

/**
 * Plans the complete companion-root migration before writing anything, then
 * rewrites only exact pre-drift appraisal jobs. Any malformed or near-legacy
 * record aborts the whole plan before the first mutation.
 */
export function migrateLegacyTurnRecordBackgroundWork(params: {
  apply: boolean;
  backupDir?: string;
  sessionsDir: string;
}): LegacyTurnRecordBackgroundWorkMigrationReport {
  const files = collectTurnRecordFiles(params.sessionsDir);
  const planned = files.flatMap((filePath) => {
    const rewrite = parseAndRepairFile(filePath);
    return rewrite ? [rewrite] : [];
  });
  if (params.apply && planned.length > 0) {
    if (!params.backupDir) {
      throw new Error('--backup-dir is required with --apply when repairs remain');
    }
    assertEmptyBackupTarget(params.backupDir);
    for (const rewrite of planned) rewriteAtomically(rewrite, params.backupDir);
  }

  const remaining = collectTurnRecordFiles(params.sessionsDir)
    .flatMap((filePath) => {
      const rewrite = parseAndRepairFile(filePath);
      return rewrite ? [rewrite] : [];
    });
  return {
    filesModified: params.apply ? planned.length - remaining.length : 0,
    filesScanned: files.length,
    mode: params.apply ? 'apply' : 'dry-run',
    recordsRepaired: params.apply
      ? planned.reduce((sum, item) => sum + item.repairedRecords, 0)
        - remaining.reduce((sum, item) => sum + item.repairedRecords, 0)
      : 0,
    remainingLegacyJobs: remaining.reduce((sum, item) => sum + item.retiredJobs, 0),
    retiredLegacyJobs: params.apply
      ? planned.reduce((sum, item) => sum + item.retiredJobs, 0)
        - remaining.reduce((sum, item) => sum + item.retiredJobs, 0)
      : 0,
    sessionsDir: params.sessionsDir,
  };
}
