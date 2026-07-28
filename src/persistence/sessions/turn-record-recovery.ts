import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type {
  TurnRecordRecoveryScanOptions,
  TurnRecordRecoveryScanStats,
} from './turn-record-store-port.js';
import {
  TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME,
  TurnRecordRecoveryEvidenceError,
} from '../../core/agent/background-work/recovery-contract.js';

interface RecoveryWorkerOptions {
  maxRowBytes: number;
  scanChunkBytes: number;
  sqliteCacheBytes: number;
  onSourceSnapshot?: (sourceChannelId: string) => void | Promise<void>;
}

type RecoveryWorkerMessage =
  | { type: 'sourceSnapshot'; sourceChannelId: string }
  | { type: 'record'; record: TurnRecord }
  | { type: 'complete'; stats: TurnRecordRecoveryScanStats }
  | { type: 'error'; name: string; message: string; stack?: string };

function abortError(): Error {
  return new DOMException('TurnRecord recovery snapshot was aborted', 'AbortError');
}

function workerError(message: Extract<RecoveryWorkerMessage, { type: 'error' }>): Error {
  const error = message.name === TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME
    ? new TurnRecordRecoveryEvidenceError(message.message)
    : new Error(message.message);
  error.name = message.name;
  if (message.stack) error.stack = message.stack;
  return error;
}

function copyStats(target: TurnRecordRecoveryScanStats | undefined, source: TurnRecordRecoveryScanStats): void {
  if (target) Object.assign(target, source);
}

export async function* streamTurnRecordRecoverySnapshot(
  sessionsDir: string,
  sourceChannelIds: readonly string[],
  options: TurnRecordRecoveryScanOptions,
  workerOptions: RecoveryWorkerOptions,
): AsyncGenerator<TurnRecord> {
  options.signal?.throwIfAborted();
  const scratchDir = mkdtempSync(join(tmpdir(), 'turn-record-recovery-'));
  const sourceExtension = extname(fileURLToPath(import.meta.url));
  const workerUrl = new URL(`./turn-record-recovery-worker${sourceExtension}`, import.meta.url);
  const worker = fork(fileURLToPath(workerUrl), [], {
    execArgv: sourceExtension === '.ts'
      ? ['--no-warnings', '--import', 'tsx']
      : ['--no-warnings'],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages: RecoveryWorkerMessage[] = [];
  const abortPath = join(scratchDir, 'abort');
  let wake: (() => void) | undefined;
  let terminalError: Error | undefined;
  let exited = false;
  const abortState = { requested: false };
  const onMessage = (message: RecoveryWorkerMessage): void => {
    messages.push(message);
    wake?.();
  };
  const onError = (error: Error): void => {
    terminalError = error;
    wake?.();
  };
  const onExit = (code: number): void => {
    exited = true;
    if (code !== 0 && !terminalError) {
      terminalError = new Error(`TurnRecord recovery worker exited with code ${code}`);
    }
    wake?.();
  };
  const onAbort = (): void => {
    if (abortState.requested) return;
    abortState.requested = true;
    terminalError = abortError();
    writeFileSync(abortPath, '', { flag: 'wx' });
    if (worker.connected) worker.send({ type: 'abort' });
    wake?.();
  };
  worker.on('message', message => onMessage(message as RecoveryWorkerMessage));
  worker.on('error', onError);
  worker.on('exit', onExit);
  worker.send({
    type: 'start',
    input: {
      abortPath,
      databasePath: join(scratchDir, 'snapshot.sqlite'),
      maxRowBytes: workerOptions.maxRowBytes,
      scanChunkBytes: workerOptions.scanChunkBytes,
      sessionsDir,
      sourceChannelIds,
      sqliteCacheBytes: workerOptions.sqliteCacheBytes,
    },
  });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const nextMessage = async (): Promise<RecoveryWorkerMessage> => {
    for (;;) {
      if (terminalError) throw terminalError;
      const message = messages.shift();
      if (message) return message;
      if (exited) throw new Error('TurnRecord recovery worker exited before completing its snapshot');
      await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
  };

  try {
    for (;;) {
      const message = await nextMessage();
      if (message.type === 'error') throw workerError(message);
      if (message.type === 'complete') {
        copyStats(options.stats, message.stats);
        return;
      }
      if (message.type === 'sourceSnapshot') {
        await workerOptions.onSourceSnapshot?.(message.sourceChannelId);
        options.signal?.throwIfAborted();
        worker.send({ type: 'continue' });
        continue;
      }
      yield message.record;
      worker.send({ type: 'continue' });
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (abortState.requested && worker.exitCode === null && worker.signalCode === null) {
      await Promise.race([
        new Promise<void>(resolve => worker.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 250)),
      ]);
    }
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>(resolve => worker.once('exit', () => resolve()));
    }
    worker.removeAllListeners();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
