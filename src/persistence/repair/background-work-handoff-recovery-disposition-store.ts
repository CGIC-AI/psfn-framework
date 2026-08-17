import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CorruptTurnRecordRecoveryEvidenceSkip } from '../../core/agent/background-work/recovery-contract.js';
import { ensureDirectoryDurableSync, writeFileDurableAtomicSync } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { withSessionJournalWriteLock } from '../sessions/store/session-journal-write-lock.js';

const BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITIONS_FILENAME =
  'background-work-handoff-recovery-dispositions.jsonl';

interface BackgroundWorkHandoffRecoveryDispositionRecord {
  schemaVersion: 1;
  errno: 'EBADMSG';
  ownerFingerprint: string;
  sourceFingerprint: string;
  retiredAtMs: number;
}

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

function fingerprintOwner(ownerSessionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['background-work-recovery-owner-id-v1', ownerSessionId.trim()]))
    .digest('hex');
}

function parseRecord(value: unknown): BackgroundWorkHandoffRecoveryDispositionRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.errno !== 'EBADMSG'
    || typeof value.ownerFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.ownerFingerprint)
    || typeof value.sourceFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.sourceFingerprint)
    || typeof value.retiredAtMs !== 'number'
    || !Number.isFinite(value.retiredAtMs)
    || value.retiredAtMs < 0) {
    throw new Error('Background-work recovery disposition record is malformed');
  }
  return value as unknown as BackgroundWorkHandoffRecoveryDispositionRecord;
}

function readRecords(path: string): BackgroundWorkHandoffRecoveryDispositionRecord[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isFile()) {
    throw new Error('Background-work recovery disposition ledger must be a regular file');
  }
  const body = readFileSync(path, 'utf8');
  if (!body.trim()) return [];
  return body.trim().split('\n').map((line) => {
    try {
      return parseRecord(JSON.parse(line) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Background-work recovery disposition ledger is malformed', {
          cause: error,
        });
      }
      throw error;
    }
  });
}

function matches(
  record: BackgroundWorkHandoffRecoveryDispositionRecord,
  skip: CorruptTurnRecordRecoveryEvidenceSkip,
): boolean {
  return record.ownerFingerprint === fingerprintOwner(skip.ownerSessionId)
    && record.sourceFingerprint === skip.sourceFingerprint;
}

export class BackgroundWorkHandoffRecoveryDispositionStore {
  private readonly rootDir: string;
  private readonly path: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.path = join(this.rootDir, BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITIONS_FILENAME);
  }

  has(skip: CorruptTurnRecordRecoveryEvidenceSkip): boolean {
    ensureDirectoryDurableSync(this.rootDir);
    return withSessionJournalWriteLock(this.path, () => (
      readRecords(this.path).some(record => matches(record, skip))
    ));
  }

  retire(skip: CorruptTurnRecordRecoveryEvidenceSkip): boolean {
    ensureDirectoryDurableSync(this.rootDir);
    return withSessionJournalWriteLock(this.path, () => {
      const records = readRecords(this.path);
      if (records.some(record => matches(record, skip))) return false;
      records.push({
        schemaVersion: 1,
        errno: 'EBADMSG',
        ownerFingerprint: fingerprintOwner(skip.ownerSessionId),
        sourceFingerprint: skip.sourceFingerprint,
        retiredAtMs: Date.now(),
      });
      const body = records.map(record => JSON.stringify(record)).join('\n');
      writeFileDurableAtomicSync(this.path, `${body}\n`);
      return true;
    });
  }
}
