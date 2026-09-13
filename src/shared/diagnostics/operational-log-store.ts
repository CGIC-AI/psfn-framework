import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync,
  fstatSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../utils/types.js';
import { sanitizeDiagnosticText, sanitizeDiagnosticValue, sanitizeOperationalMetadata } from './redaction.js';
import { operationalMetadataCutoff, requireOperationalMetadataRetentionDays } from './retention-policy.js';

export interface DiagnosticLogRecord {
  observedAt: number;
  level: 'warn' | 'error' | 'info' | 'debug' | 'trace';
  eventId?: string;
  message: string;
  component?: string;
  context?: Record<string, string | number | boolean | null>;
  source: string;
}

interface OperationalLogStoreOptions {
  logsDir: string;
  process: 'agent' | 'gateway' | 'operator';
  companionId?: string;
  retentionDays: number;
  now?: () => number;
}

const LOG_FILE_NAME = /^(\d{4}-\d{2}-\d{2})\.(agent|gateway|operator)\.[a-f0-9-]+\.jsonl$/;
const COMPANION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const READ_BLOCK_BYTES = 8192;

/** Append-only operational metadata on the existing persistent runtime log root.
 * Each boot owns its files; age pruning never truncates another writer's file.
 * Synchronous append leaves no application queue to lose on process.exit/crash.
 * close flushes the kernel's file buffers before a graceful shutdown returns.
 */
export class OperationalLogStore {
  readonly directory: string;
  private readonly bootId = randomUUID();
  private readonly now: () => number;
  private fd: number | undefined;
  private day: string | undefined;

  constructor(private readonly options: OperationalLogStoreOptions) {
    requireOperationalMetadataRetentionDays(options.retentionDays);
    if (!options.logsDir.trim()) throw new Error('Operational metadata requires a persistent logsDir');
    if (options.process === 'agent' && !options.companionId) {
      throw new Error('Agent operational metadata requires a companion identity');
    }
    if (options.companionId !== undefined && !COMPANION_ID.test(options.companionId)) {
      throw new Error('Invalid operational metadata companion identity');
    }
    this.directory = join(options.logsDir, options.companionId ? `companion-${options.companionId}` : 'system');
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.rotate();
  }

  record(record: DiagnosticLogRecord, metadata?: Record<string, unknown>): void {
    this.rotate();
    // Only the logger's allowlisted scalar context reaches this seam, then it
    // is sanitized again so direct callers cannot smuggle prompt/body fields.
    const context = record.context
      ? Object.fromEntries(Object.entries(record.context).map(([key, value]) => [key, sanitizeDiagnosticValue(value, key)]))
      : undefined;
    const line = JSON.stringify({
      eventId: randomUUID(),
      observedAt: record.observedAt,
      timestamp: new Date(record.observedAt).toISOString(),
      process: this.options.process,
      ...(this.options.companionId ? { companionId: this.options.companionId } : {}),
      level: record.level,
      component: sanitizeDiagnosticText(record.component),
      message: sanitizeDiagnosticText(record.message),
      ...(context ? { context } : {}),
      ...(metadata ? { metadata: sanitizeOperationalMetadata(metadata) } : {}),
    }) + '\n';
    const buffer = Buffer.from(line);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(this.fd!, buffer, offset, buffer.length - offset);
      if (written === 0) throw new Error('Operational metadata append made no progress');
      offset += written;
    }
  }

  close(): void {
    if (this.fd !== undefined) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  private rotate(): void {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === this.day && this.fd !== undefined) return;
    this.close();
    const cutoff = operationalMetadataCutoff(now, this.options.retentionDays);
    for (const file of readdirSync(this.directory, { withFileTypes: true })) {
      const match = LOG_FILE_NAME.exec(file.name);
      if (!file.isFile() || !match) continue;
      const dayEnd = Date.parse(`${match[1]}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
      if (dayEnd < cutoff) unlinkSync(join(this.directory, file.name));
    }
    this.fd = openSync(join(this.directory, `${day}.${this.options.process}.${this.bootId}.jsonl`), 'a', 0o600);
    this.day = day;
  }
}

/** Read lines backwards in fixed blocks: a noisy day never becomes a whole-file
 * allocation, and a historical query can seek beyond today's log tail. */
function* reverseLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    let offset = fstatSync(fd).size;
    let pending = Buffer.alloc(0);
    while (offset > 0) {
      const length = Math.min(READ_BLOCK_BYTES, offset);
      offset -= length;
      const block = Buffer.alloc(length);
      readSync(fd, block, 0, length, offset);
      pending = Buffer.concat([block, pending]);
      let end = pending.length;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index] !== 10) continue;
        const line = pending.subarray(index + 1, end).toString('utf8');
        if (line) yield line;
        end = index;
      }
      pending = pending.subarray(0, end);
    }
    if (pending.length > 0) yield pending.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readOperationalLogHistory(directory: string, query: {
  sinceMs: number;
  untilMs: number;
  limit: number;
}): { filesScanned: number; records: DiagnosticLogRecord[] } {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('Operational log query requires a positive limit');
  const records: DiagnosticLogRecord[] = [];
  let filesScanned = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = LOG_FILE_NAME.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (day > query.untilMs || day + 24 * 60 * 60 * 1000 < query.sinceMs) continue;
    filesScanned += 1;
    let selected = 0;
    for (const line of reverseLines(join(directory, entry.name))) {
      // An interrupted final write can leave a partial line. Report corruption
      // rather than presenting silently incomplete historical evidence.
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.observedAt !== 'number'
        || !['error', 'warn', 'info', 'debug', 'trace'].includes(String(value.level))) {
        throw new Error('Invalid persisted operational metadata record');
      }
      if (value.observedAt < query.sinceMs || value.observedAt > query.untilMs) continue;
      records.push({
        eventId: String(value.eventId),
        observedAt: value.observedAt,
        level: value.level as DiagnosticLogRecord['level'],
        message: sanitizeDiagnosticText(value.message),
        component: sanitizeDiagnosticText(value.component),
        ...(isRecord(value.context) ? { context: Object.fromEntries(Object.entries(value.context).map(([key, item]) => [key, sanitizeDiagnosticValue(item, key)])) } : {}),
        source: `file:${entry.name}`,
      });
      selected += 1;
      if (selected >= query.limit) break;
    }
  }
  records.sort((a, b) => b.observedAt - a.observedAt);
  return { filesScanned, records: records.slice(0, query.limit) };
}
