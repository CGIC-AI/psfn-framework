import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import type { JournalEntry } from '../../core/session/types.js';
import { fileIdentityKey } from '../jsonl-segments.js';
import { parseJournalLine } from '../journals/journal/file-io.js';

interface WorkerInput {
  channelId: string;
  filePaths: readonly string[];
  maxActionBytes: number;
  maxActions: number;
  maxResultBytes: number;
  maxRowBytes: number;
  scanChunkBytes: number;
}

interface SnapshotFile {
  fd: number;
  identity: string;
  path: string;
  size: number;
}

interface AuthorityActionEvidence {
  archiveIndex: number;
  entry: JournalEntry;
  previousHmac: string | null;
}

interface AuthorityScanStats {
  actionBytesReturned: number;
  actionsReturned: number;
  bytesRead: number;
  filesScanned: number;
  peakRowBytes: number;
  rowsScanned: number;
}

const input = await new Promise<WorkerInput>((resolve) => {
  process.once('message', (message: unknown) => {
    resolve((message as { type: 'start'; input: WorkerInput }).input);
  });
});

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    process.once('message', resolve);
  });
}

function evidenceError(message: string, code?: string, cause?: unknown): Error {
  const error = new Error(message, { cause }) as NodeJS.ErrnoException;
  error.name = 'TurnRecordRecoveryEvidenceError';
  if (code) error.code = code;
  return error;
}

function openSnapshots(filePaths: readonly string[]): SnapshotFile[] {
  const snapshots: SnapshotFile[] = [];
  const identities = new Set<string>();
  try {
    for (const path of filePaths) {
      const fd = openSync(path, 'r');
      try {
        const stat = fstatSync(fd);
        const identity = fileIdentityKey(stat);
        if (identities.has(identity)) {
          throw evidenceError(
            `L0 authority chain for ${input.channelId} contains duplicate file identity ${identity}`,
          );
        }
        identities.add(identity);
        snapshots.push({ fd, identity, path, size: stat.size });
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
    return snapshots;
  } catch (error) {
    for (const snapshot of snapshots) closeSync(snapshot.fd);
    throw evidenceError(
      `Cannot capture L0 tombstone authority for ${input.channelId}`,
      undefined,
      error,
    );
  }
}

async function run(): Promise<void> {
  const snapshots = openSnapshots(input.filePaths);
  const actions: AuthorityActionEvidence[] = [];
  const stats: AuthorityScanStats = {
    actionBytesReturned: 0,
    actionsReturned: 0,
    bytesRead: 0,
    filesScanned: 0,
    peakRowBytes: 0,
    rowsScanned: 0,
  };
  let previousHmac: string | null = null;
  try {
    process.send?.({ type: 'snapshot' });
    await waitForContinue();
    for (let archiveIndex = 0; archiveIndex < snapshots.length; archiveIndex += 1) {
      const snapshot = snapshots[archiveIndex]!;
      stats.filesScanned += 1;
      const chunk = Buffer.allocUnsafe(input.scanChunkBytes);
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let position = 0;
      const consumeLine = (tail: Buffer): void => {
        const rowBytes = bufferedBytes + tail.length;
        stats.peakRowBytes = Math.max(stats.peakRowBytes, rowBytes);
        if (rowBytes > input.maxRowBytes) {
          throw evidenceError(
            `L0 authority row in ${snapshot.path} exceeds ${input.maxRowBytes} bytes`,
            'EOVERFLOW',
          );
        }
        const line = (buffered.length === 0
          ? tail
          : Buffer.concat([...buffered, tail], rowBytes)).toString('utf8').trim();
        buffered = [];
        bufferedBytes = 0;
        if (!line) return;
        let entry: JournalEntry;
        try {
          entry = parseJournalLine(line);
        } catch (error) {
          throw evidenceError(
            `Malformed L0 authority row in ${snapshot.path}: `
            + `${error instanceof Error ? error.message : String(error)}`,
            'EBADMSG',
            error,
          );
        }
        stats.rowsScanned += 1;
        if (entry.channelId !== input.channelId) {
          throw evidenceError(
            `L0 authority row channel mismatch in ${snapshot.path}: `
            + `expected ${input.channelId}, found ${entry.channelId}`,
            'EBADMSG',
          );
        }
        if (entry.type === 'tombstone') {
          if (rowBytes > input.maxActionBytes) {
            throw evidenceError(
              `L0 tombstone authority action in ${snapshot.path} exceeds `
              + `${input.maxActionBytes} bytes`,
              'EOVERFLOW',
            );
          }
          if (actions.length >= input.maxActions
            || stats.actionBytesReturned + rowBytes > input.maxResultBytes) {
            throw evidenceError(
              `L0 tombstone authority for ${input.channelId} exceeds its bounded result budget`,
              'EOVERFLOW',
            );
          }
          actions.push({ archiveIndex, entry, previousHmac });
          stats.actionBytesReturned += rowBytes;
          stats.actionsReturned += 1;
        }
        previousHmac = typeof entry._hmac === 'string' ? entry._hmac : null;
      };

      while (position < snapshot.size) {
        const bytesRead = readSync(
          snapshot.fd,
          chunk,
          0,
          Math.min(chunk.length, snapshot.size - position),
          position,
        );
        if (bytesRead <= 0) {
          throw evidenceError(
            `L0 authority snapshot ended early for ${snapshot.path}`,
            'ESTALE',
          );
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
          stats.peakRowBytes = Math.max(stats.peakRowBytes, bufferedBytes);
          if (bufferedBytes > input.maxRowBytes) {
            throw evidenceError(
              `L0 authority row in ${snapshot.path} exceeds ${input.maxRowBytes} bytes`,
              'EOVERFLOW',
            );
          }
        }
      }
      if (bufferedBytes > 0) consumeLine(Buffer.alloc(0));
    }

    for (const snapshot of snapshots) {
      const descriptorStat = fstatSync(snapshot.fd);
      let pathStat;
      try {
        pathStat = statSync(snapshot.path);
      } catch (error) {
        throw evidenceError(
          `L0 authority path changed while scanning ${snapshot.path}`,
          'ESTALE',
          error,
        );
      }
      if (
        fileIdentityKey(descriptorStat) !== snapshot.identity
        || descriptorStat.size !== snapshot.size
        || fileIdentityKey(pathStat) !== snapshot.identity
        || pathStat.size !== snapshot.size
      ) {
        throw evidenceError(
          `L0 authority evidence changed while scanning ${snapshot.path}`,
          'ESTALE',
        );
      }
    }
    process.send?.({ type: 'complete', actions, stats });
  } finally {
    for (const snapshot of snapshots) closeSync(snapshot.fd);
  }
}

run().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const code = (normalized as NodeJS.ErrnoException).code;
  const message = {
    type: 'error',
    name: normalized.name,
    message: normalized.message,
    ...(code ? { code } : {}),
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  };
  if (process.connected) {
    process.send!(message, () => {
      if (process.connected) process.disconnect();
    });
  }
});
