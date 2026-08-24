import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type DurableWriteStage = 'after_file_sync' | 'after_publish' | 'after_directory_sync';

export interface DurableWriteOptions {
  /** Publish without replacing any existing final path. */
  exclusive?: boolean;
  /** POSIX mode for the newly published file; defaults to owner-only. */
  mode?: number;
  faultInjection?: (stage: DurableWriteStage, path: string) => void;
}

export function fsyncDirectorySync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Flushes a completed tree bottom-up so a later directory rename can publish it durably. */
export function fsyncTreeSync(path: string): void {
  const stats = lstatSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) fsyncTreeSync(join(path, entry));
    fsyncDirectorySync(path);
    return;
  }
  if (!stats.isFile()) throw new Error(`Durable tree contains a non-regular entry: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function ensureDirectoryDurableSync(path: string): void {
  if (existsSync(path)) return;
  const parent = dirname(path);
  if (parent !== path) ensureDirectoryDurableSync(parent);
  try {
    mkdirSync(path);
    fsyncDirectorySync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function writeFileDurableAtomicSync(
  path: string,
  content: string | Buffer,
  options: DurableWriteOptions = {},
): void {
  const parent = dirname(path);
  ensureDirectoryDurableSync(parent);
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      options.mode ?? 0o600,
    );
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    options.faultInjection?.('after_file_sync', path);
    closeSync(descriptor);
    descriptor = null;
    if (options.exclusive) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
    options.faultInjection?.('after_publish', path);
    fsyncDirectorySync(parent);
    options.faultInjection?.('after_directory_sync', path);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function unlinkDurableSync(path: string): void {
  unlinkSync(path);
  fsyncDirectorySync(dirname(path));
}

export interface WriteJsonAtomicOptions {
  space?: number;
  trailingNewline?: boolean;
  mode?: number;
}

export function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });

  const space = options.space ?? 2;
  const trailingNewline = options.trailingNewline ?? true;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = JSON.stringify(value, null, space);
  const payload = trailingNewline ? `${body}\n` : body;

  try {
    writeFileSync(tmpPath, payload, {
      encoding: 'utf-8',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}
