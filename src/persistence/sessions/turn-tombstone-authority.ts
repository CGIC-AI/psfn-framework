import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEntry } from '../../core/session/types.js';

export interface TurnTombstoneAuthorityActionEvidence {
  archiveIndex: number;
  entry: JournalEntry;
  previousHmac: string | null;
}

export interface TurnTombstoneAuthorityScanStats {
  actionBytesReturned: number;
  actionsReturned: number;
  bytesRead: number;
  filesScanned: number;
  peakOpenFiles: number;
  peakRowBytes: number;
  rowsScanned: number;
}

export interface TurnTombstoneAuthoritySnapshot {
  actions: TurnTombstoneAuthorityActionEvidence[];
  stats: TurnTombstoneAuthorityScanStats;
}

export interface TurnTombstoneAuthorityScanOptions {
  channelId: string;
  filePaths: readonly string[];
  maxActionBytes: number;
  maxActions: number;
  maxResultBytes: number;
  maxRowBytes: number;
  onSnapshot?: () => void | Promise<void>;
  scanChunkBytes: number;
  signal?: AbortSignal;
}

type WorkerMessage =
  | { type: 'snapshot' }
  | { type: 'complete'; actions: TurnTombstoneAuthorityActionEvidence[]; stats: TurnTombstoneAuthorityScanStats }
  | { type: 'error'; name: string; message: string; code?: string; stack?: string };

function abortError(): Error {
  return new DOMException('L0 tombstone authority scan was aborted', 'AbortError');
}

function workerError(message: Extract<WorkerMessage, { type: 'error' }>): Error {
  const error = new Error(message.message) as NodeJS.ErrnoException;
  error.name = message.name;
  if (message.code) error.code = message.code;
  if (message.stack) error.stack = message.stack;
  return error;
}

export async function readTurnTombstoneAuthoritySnapshot(
  options: TurnTombstoneAuthorityScanOptions,
): Promise<TurnTombstoneAuthoritySnapshot> {
  options.signal?.throwIfAborted();
  const sourceExtension = extname(fileURLToPath(import.meta.url));
  const workerUrl = new URL(`./turn-tombstone-authority-worker${sourceExtension}`, import.meta.url);
  const worker = fork(fileURLToPath(workerUrl), [], {
    execArgv: sourceExtension === '.ts'
      ? ['--no-warnings', '--import', 'tsx']
      : ['--no-warnings'],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let settled = false;
  const onAbort = (): void => {
    if (settled) return;
    worker.kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await new Promise<TurnTombstoneAuthoritySnapshot>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', (code, signal) => {
        if (settled) return;
        reject(options.signal?.aborted
          ? abortError()
          : new Error(
            `L0 tombstone authority worker exited before completion `
            + `(code=${String(code)}, signal=${String(signal)})`,
          ));
      });
      worker.on('message', (raw: unknown) => {
        void (async () => {
          const message = raw as WorkerMessage;
          if (message.type === 'error') {
            settled = true;
            reject(workerError(message));
            return;
          }
          if (message.type === 'complete') {
            settled = true;
            resolve({ actions: message.actions, stats: message.stats });
            return;
          }
          try {
            await options.onSnapshot?.();
            options.signal?.throwIfAborted();
            worker.send({ type: 'continue' });
          } catch (error) {
            settled = true;
            reject(error);
          }
        })();
      });
      worker.send({
        type: 'start',
        input: {
          channelId: options.channelId,
          filePaths: options.filePaths,
          maxActionBytes: options.maxActionBytes,
          maxActions: options.maxActions,
          maxResultBytes: options.maxResultBytes,
          maxRowBytes: options.maxRowBytes,
          scanChunkBytes: options.scanChunkBytes,
        },
      });
    });
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>(resolve => worker.once('exit', () => resolve()));
    }
    worker.removeAllListeners();
  }
}
