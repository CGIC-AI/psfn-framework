import {
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface WriteJsonAtomicOptions {
  space?: number;
  trailingNewline?: boolean;
}

export function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });

  const space = options.space ?? 2;
  const trailingNewline = options.trailingNewline ?? true;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = JSON.stringify(value, null, space);
  const payload = trailingNewline ? `${body}\n` : body;

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
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
