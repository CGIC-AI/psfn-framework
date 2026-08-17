import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import {
  repairLegacyTurnRecordBackgroundWorkHandoffForRecovery,
} from '../../core/agent/background-work/types.js';
import {
  TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE,
  TurnRecordRecoveryEvidenceError,
  isTurnRecordRecoveryEvidenceError,
} from '../../core/agent/background-work/recovery-contract.js';
import { fileIdentityKey } from '../jsonl-segments.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import {
  normalizeTurnRecord,
  projectTurnRecordRecoveryCandidate,
  withTurnRecordRotationLock,
} from './turn-records.js';
import { quarantineTurnRecordRecoveryLine } from './turn-record-recovery-quarantine.js';
import type { TurnRecordRecoveryScanStats } from './turn-record-store-port.js';

interface WorkerInput {
  abortPath: string;
  databasePath: string;
  maxRowBytes: number;
  scanChunkBytes: number;
  sessionsDir: string;
  sourceChannelIds: readonly string[];
  sqliteCacheBytes: number;
}

interface SnapshotFile {
  fd: number;
  path: string;
  size: number;
}

interface SourceSnapshotBoundary {
  activeSnapshot: SnapshotFile | null;
  maximumSealedSegmentNumber: number;
}

const sqliteModuleSpecifier = ['node', 'sqlite'].join(':');
const { DatabaseSync } = await import(sqliteModuleSpecifier) as typeof import('node:sqlite');
const input = await new Promise<WorkerInput>((resolve) => {
  process.once('message', (message: unknown) => {
    resolve((message as { type: 'start'; input: WorkerInput }).input);
  });
});
const stats: TurnRecordRecoveryScanStats = {
  bytesRead: 0,
  rowsScanned: 0,
  filesScanned: 0,
  candidatesYielded: 0,
  peakIdentityRowsInMemory: 1,
  sqliteCacheBytes: input.sqliteCacheBytes,
  maxRowBytes: input.maxRowBytes,
  legacyEmotionAppraisalJobsRetired: 0,
  quarantinedTurnRecordRows: 0,
};

function assertNotAborted(): void {
  if (!process.connected || existsSync(input.abortPath)) {
    throw new DOMException('TurnRecord recovery snapshot was aborted', 'AbortError');
  }
}

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    process.once('message', resolve);
  });
}

function postMessage(message: unknown): void {
  process.send?.(message);
}

function evidenceError(message: string, cause?: unknown): Error {
  const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new TurnRecordRecoveryEvidenceError(message, {
    cause,
    code: typeof causeCode === 'string' && causeCode
      ? causeCode
      : TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE,
  });
}

function openSnapshot(path: string, missingAllowed: boolean): SnapshotFile | null {
  try {
    const fd = openSync(path, 'r');
    try {
      return { fd, path, size: fstatSync(fd).size };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function segmentPattern(activePath: string): RegExp {
  const escaped = basename(activePath, '.jsonl').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.(\\d{5,})\\.jsonl$`);
}

function segmentPath(activePath: string, segmentNumber: number): string {
  return join(
    dirname(activePath),
    `${basename(activePath, '.jsonl')}.${String(segmentNumber).padStart(5, '0')}.jsonl`,
  );
}

function captureSourceSnapshotBoundary(
  directory: string,
  activePath: string,
  sourceChannelId: string,
): SourceSnapshotBoundary {
  if (!existsSync(directory)) {
    return { activeSnapshot: null, maximumSealedSegmentNumber: 0 };
  }
  const pinned = { active: null as SnapshotFile | null };
  try {
    return withTurnRecordRotationLock(activePath, () => {
      try {
        assertNotAborted();
        pinned.active = openSnapshot(activePath, true);
        let sealedSegmentCount = 0;
        let maximumSealedSegmentNumber = 0;
        const pattern = segmentPattern(activePath);
        const directoryHandle = opendirSync(directory);
        try {
          for (;;) {
            const entry = directoryHandle.readSync();
            if (!entry) break;
            if (!entry.isFile()) continue;
            const match = pattern.exec(entry.name);
            if (!match) continue;
            const segmentNumber = Number(match[1]);
            if (!Number.isSafeInteger(segmentNumber) || segmentNumber < 1) {
              throw evidenceError(
                `TurnRecord recovery segment number is invalid for ${sourceChannelId}: ${entry.name}`,
              );
            }
            sealedSegmentCount += 1;
            maximumSealedSegmentNumber = Math.max(maximumSealedSegmentNumber, segmentNumber);
          }
        } finally {
          directoryHandle.closeSync();
        }
        if (sealedSegmentCount !== maximumSealedSegmentNumber) {
          throw evidenceError(
            `TurnRecord recovery segment fence is ambiguous for ${sourceChannelId}: `
            + `found ${sealedSegmentCount} files through segment ${maximumSealedSegmentNumber}`,
          );
        }
        return { activeSnapshot: pinned.active, maximumSealedSegmentNumber };
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError')
          || isTurnRecordRecoveryEvidenceError(error)) {
          throw error;
        }
        throw evidenceError(
          `TurnRecord recovery could not capture the segment fence for ${sourceChannelId}`,
          error,
        );
      }
    }, assertNotAborted);
  } catch (error) {
    if (pinned.active) closeSync(pinned.active.fd);
    throw error;
  }
}

async function run(): Promise<void> {
  const database = new DatabaseSync(input.databasePath, { defensive: true });
  let activeSnapshot: SnapshotFile | null = null;
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -${Math.max(1, Math.floor(input.sqliteCacheBytes / 1024))};
      CREATE TABLE files (
        identity TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL,
        origin_kind TEXT NOT NULL,
        alias_segment INTEGER
      );
      CREATE TABLE records (
        source_channel TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        occurrences INTEGER NOT NULL,
        completed_at REAL,
        recovery_json TEXT,
        PRIMARY KEY (source_channel, turn_id)
      ) WITHOUT ROWID;
    `);
    const claimFile = database.prepare(
      'INSERT OR IGNORE INTO files(identity, source_channel, origin_kind) VALUES (?, ?, ?)',
    );
    const readFileOwner = database.prepare(
      'SELECT source_channel, origin_kind, alias_segment FROM files WHERE identity = ?',
    );
    const markActiveAlias = database.prepare(
      'UPDATE files SET alias_segment = ? WHERE identity = ? AND alias_segment IS NULL',
    );
    const indexRecord = database.prepare(`
      INSERT INTO records(source_channel, turn_id, occurrences, completed_at, recovery_json)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(source_channel, turn_id) DO UPDATE SET
        occurrences = 2,
        recovery_json = NULL
    `);
    const scanFile = (
      snapshot: SnapshotFile,
      sourceChannelId: string,
      activePath: string,
      originKind: 'active' | 'segment',
      segmentNumber?: number,
    ): void => {
      const identity = fileIdentityKey(fstatSync(snapshot.fd));
      const claimed = Number(claimFile.run(identity, sourceChannelId, originKind).changes) === 1;
      if (!claimed) {
        const owner = readFileOwner.get(identity) as {
          source_channel: string;
          origin_kind: 'active' | 'segment';
          alias_segment: number | null;
        };
        if (owner.source_channel !== sourceChannelId) {
          throw evidenceError(
            `TurnRecord recovery inode is shared by multiple sources: ${identity}`,
          );
        }
        if (originKind === 'segment'
          && segmentNumber !== undefined
          && owner.origin_kind === 'active'
          && owner.alias_segment === null
          && Number(markActiveAlias.run(segmentNumber, identity).changes) === 1) {
          return;
        }
        throw evidenceError(
          `TurnRecord recovery file identity is ambiguous for ${sourceChannelId}: ${identity}`,
        );
      }
      if (snapshot.size === 0) return;
      stats.filesScanned += 1;
      const chunk = Buffer.allocUnsafe(input.scanChunkBytes);
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let position = 0;
      let physicalRowNumber = 0;
      const consumeLine = (tail: Buffer): void => {
        physicalRowNumber += 1;
        const rowBytes = bufferedBytes + tail.length;
        if (rowBytes > input.maxRowBytes) {
          throw evidenceError(
            `TurnRecord recovery row in ${snapshot.path} exceeds ${input.maxRowBytes} bytes`,
          );
        }
        const line = (buffered.length === 0
          ? tail
          : Buffer.concat([...buffered, tail], rowBytes)).toString('utf8').trim();
        buffered = [];
        bufferedBytes = 0;
        if (!line) return;
        assertNotAborted();
        let record: TurnRecord;
        try {
          record = normalizeTurnRecord(JSON.parse(line) as unknown, sourceChannelId);
          if (record.status === 'completed' && record.backgroundWorkHandoff) {
            const repair = repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record);
            record = repair.record;
            stats.legacyEmotionAppraisalJobsRetired =
              (stats.legacyEmotionAppraisalJobsRetired ?? 0)
              + repair.retiredLegacyEmotionAppraisalJobs;
          }
        } catch {
          try {
            withTurnRecordRotationLock(
              activePath,
              () => quarantineTurnRecordRecoveryLine(
                activePath,
                sourceChannelId,
                line,
                `${identity}:${String(physicalRowNumber)}`,
                input.scanChunkBytes,
              ),
              assertNotAborted,
            );
          } catch (quarantineError) {
            throw evidenceError(
              `TurnRecord recovery could not durably quarantine an invalid row for ${sourceChannelId}`,
              quarantineError,
            );
          }
          stats.quarantinedTurnRecordRows = (stats.quarantinedTurnRecordRows ?? 0) + 1;
          return;
        }
        stats.rowsScanned += 1;
        const candidate = record.status === 'completed' && record.backgroundWorkHandoff
          ? JSON.stringify(projectTurnRecordRecoveryCandidate(record))
          : null;
        indexRecord.run(
          sourceChannelId,
          record.turnId,
          record.completedAt,
          candidate,
        );
      };
      while (position < snapshot.size) {
        assertNotAborted();
        const bytesRead = readSync(
          snapshot.fd,
          chunk,
          0,
          Math.min(chunk.length, snapshot.size - position),
          position,
        );
        if (bytesRead <= 0) {
          throw new Error(`TurnRecord recovery snapshot ended early: ${snapshot.path}`);
        }
        position += bytesRead;
        stats.bytesRead += bytesRead;
        let lineStart = 0;
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          consumeLine(chunk.subarray(lineStart, index));
          lineStart = index + 1;
        }
        if (lineStart < bytesRead) {
          const tail = Buffer.from(chunk.subarray(lineStart, bytesRead));
          buffered.push(tail);
          bufferedBytes += tail.length;
          if (bufferedBytes > input.maxRowBytes) {
            throw evidenceError(
              `TurnRecord recovery row in ${snapshot.path} exceeds ${input.maxRowBytes} bytes`,
            );
          }
        }
      }
      if (bufferedBytes > 0) consumeLine(Buffer.alloc(0));
    };

    database.exec('BEGIN');
    for (const sourceChannelId of [...new Set(input.sourceChannelIds)]) {
      assertNotAborted();
      const sanitized = sanitizeChannelId(sourceChannelId);
      const directory = join(input.sessionsDir, '_turn_records');
      const activePath = join(directory, `${sanitized}.jsonl`);
      const boundary = captureSourceSnapshotBoundary(directory, activePath, sourceChannelId);
      activeSnapshot = boundary.activeSnapshot;
      postMessage({ type: 'sourceSnapshot', sourceChannelId });
      await waitForContinue();
      assertNotAborted();
      if (activeSnapshot) {
        try {
          scanFile(activeSnapshot, sourceChannelId, activePath, 'active');
        } finally {
          closeSync(activeSnapshot.fd);
          activeSnapshot = null;
        }
      }
      for (
        let segmentNumber = 1;
        segmentNumber <= boundary.maximumSealedSegmentNumber;
        segmentNumber += 1
      ) {
        const path = segmentPath(activePath, segmentNumber);
        let snapshot: SnapshotFile;
        try {
          snapshot = openSnapshot(path, false)!;
        } catch (error) {
          throw evidenceError(
            `TurnRecord recovery fenced segment ${segmentNumber} is missing for `
            + `${sourceChannelId}: ${path}`,
            error,
          );
        }
        try {
          scanFile(snapshot, sourceChannelId, activePath, 'segment', segmentNumber);
        } finally {
          closeSync(snapshot.fd);
        }
      }
    }
    database.exec('COMMIT');

    const ordered = database.prepare(`
      SELECT recovery_json
      FROM records
      WHERE occurrences = 1 AND recovery_json IS NOT NULL
      ORDER BY completed_at ASC, turn_id ASC, source_channel ASC
    `);
    for (const row of ordered.iterate() as Iterable<{ recovery_json: string }>) {
      assertNotAborted();
      const record = JSON.parse(row.recovery_json) as TurnRecord;
      stats.candidatesYielded += 1;
      postMessage({ type: 'record', record });
      await waitForContinue();
    }
    postMessage({ type: 'complete', stats });
  } finally {
    if (activeSnapshot) closeSync(activeSnapshot.fd);
    database.close();
  }
}

run().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const message = {
    type: 'error',
    code: (normalized as NodeJS.ErrnoException).code,
    name: normalized.name,
    message: normalized.message,
    stack: normalized.stack,
  };
  if (process.connected) {
    process.send!(message, () => {
      if (process.connected) process.disconnect();
    });
  }
});
