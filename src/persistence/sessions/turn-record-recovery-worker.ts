import {
  closeSync,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { fileIdentityKey } from '../jsonl-segments.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import { normalizeTurnRecordRecoveryCandidate } from './turn-records.js';
import type { TurnRecordRecoveryScanStats } from './turn-record-store-port.js';

interface WorkerInput {
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
};

function assertNotAborted(): void {
  if (!process.connected) {
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
  const error = new Error(message, { cause });
  error.name = 'TurnRecordRecoveryEvidenceError';
  return error;
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
  return new RegExp(`^${escaped}\\.\\d{5,}\\.jsonl$`);
}

async function run(): Promise<void> {
  const database = new DatabaseSync(input.databasePath);
  let activeSnapshot: SnapshotFile | null = null;
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -${Math.max(1, Math.floor(input.sqliteCacheBytes / 1024))};
      CREATE TABLE files (
        identity TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL
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
      'INSERT OR IGNORE INTO files(identity, source_channel) VALUES (?, ?)',
    );
    const readFileOwner = database.prepare(
      'SELECT source_channel FROM files WHERE identity = ?',
    );
    const indexRecord = database.prepare(`
      INSERT INTO records(source_channel, turn_id, occurrences, completed_at, recovery_json)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(source_channel, turn_id) DO UPDATE SET
        occurrences = 2,
        recovery_json = NULL
    `);
    const scanFile = (snapshot: SnapshotFile, sourceChannelId: string): void => {
      const identity = fileIdentityKey(fstatSync(snapshot.fd));
      const claimed = Number(claimFile.run(identity, sourceChannelId).changes) === 1;
      if (!claimed) {
        const owner = readFileOwner.get(identity) as { source_channel: string };
        if (owner.source_channel !== sourceChannelId) {
          throw evidenceError(
            `TurnRecord recovery inode is shared by multiple sources: ${identity}`,
          );
        }
        return;
      }
      if (snapshot.size === 0) return;
      stats.filesScanned += 1;
      const chunk = Buffer.allocUnsafe(input.scanChunkBytes);
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let position = 0;
      const consumeLine = (tail: Buffer): void => {
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
          record = normalizeTurnRecordRecoveryCandidate(
            JSON.parse(line) as unknown,
            sourceChannelId,
          );
        } catch (error) {
          throw evidenceError(
            `Invalid TurnRecord recovery row in ${snapshot.path}: `
            + `${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
        stats.rowsScanned += 1;
        const candidate = record.status === 'completed' && record.backgroundWorkHandoff
          ? JSON.stringify(record)
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
      activeSnapshot = openSnapshot(activePath, true);
      postMessage({ type: 'sourceSnapshot', sourceChannelId });
      await waitForContinue();
      assertNotAborted();
      try {
        const directoryHandle = opendirSync(directory);
        try {
          const pattern = segmentPattern(activePath);
          for (;;) {
            const entry = directoryHandle.readSync();
            if (!entry) break;
            if (!entry.isFile() || !pattern.test(entry.name)) continue;
            const snapshot = openSnapshot(join(directory, entry.name), false)!;
            try {
              scanFile(snapshot, sourceChannelId);
            } finally {
              closeSync(snapshot.fd);
            }
          }
        } finally {
          directoryHandle.closeSync();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || activeSnapshot) throw error;
      }
      if (activeSnapshot) {
        try {
          scanFile(activeSnapshot, sourceChannelId);
        } finally {
          closeSync(activeSnapshot.fd);
          activeSnapshot = null;
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
  postMessage({
    type: 'error',
    name: normalized.name,
    message: normalized.message,
    stack: normalized.stack,
  });
});
