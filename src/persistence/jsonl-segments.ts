import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const NEWLINE_BYTE = 0x0a;

export interface NumberedJsonlSegment {
  segmentNumber: number;
  path: string;
}

export interface JsonlReadStats {
  bytesRead: number;
  readCalls?: number;
  filesRead?: number;
}

export interface JsonlScanOptions {
  chunkBytes: number;
  stats?: JsonlReadStats;
  scannedFileIdentities?: Set<string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fileIdentityKey(stat: { dev: number | bigint; ino: number | bigint }): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Discover sealed siblings for an active JSONL file using the hgw3 contract:
 * `<stem>.00001.jsonl`, `<stem>.00002.jsonl`, ... Higher numbers are newer.
 * The directory listing is authoritative; there is deliberately no manifest.
 */
export function listNumberedJsonlSegments(activePath: string): NumberedJsonlSegment[] {
  const directory = dirname(activePath);
  if (!existsSync(directory)) return [];
  const activeName = basename(activePath);
  const extension = extname(activeName);
  const stem = activeName.slice(0, -extension.length);
  const pattern = new RegExp(`^${escapeRegExp(stem)}\\.(\\d{5,})${escapeRegExp(extension)}$`);
  const segments: NumberedJsonlSegment[] = [];
  for (const name of readdirSync(directory)) {
    const match = pattern.exec(name);
    if (!match) continue;
    segments.push({
      segmentNumber: Number(match[1]),
      path: join(directory, name),
    });
  }
  return segments;
}

function recordFileRead(stats: JsonlReadStats | undefined): void {
  if (stats?.filesRead !== undefined) stats.filesRead += 1;
}

function recordChunkRead(stats: JsonlReadStats | undefined, bytesRead: number): void {
  if (!stats) return;
  stats.bytesRead += bytesRead;
  if (stats.readCalls !== undefined) stats.readCalls += 1;
}

function claimFileIdentity(
  fd: number,
  stats: JsonlReadStats | undefined,
  scannedFileIdentities: Set<string> | undefined,
): { claimed: boolean; size: number } {
  const fileStat = fstatSync(fd);
  const identity = fileIdentityKey(fileStat);
  if (scannedFileIdentities?.has(identity)) {
    return { claimed: false, size: fileStat.size };
  }
  scannedFileIdentities?.add(identity);
  recordFileRead(stats);
  return { claimed: true, size: fileStat.size };
}

/**
 * Scan newline-delimited bytes from newest to oldest. Lines larger than the
 * chunk size and multi-byte UTF-8 text are reassembled before decoding.
 */
export function scanJsonlFileBackward(
  path: string,
  options: JsonlScanOptions,
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFileIdentity(fd, options.stats, options.scannedFileIdentities);
    if (!claimed.claimed || claimed.size <= 0) return false;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    let position = claimed.size;
    let remainder = Buffer.alloc(0);

    while (position > 0) {
      const bytesToRead = Math.min(options.chunkBytes, position);
      position -= bytesToRead;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      recordChunkRead(options.stats, bytesRead);

      const combined = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== NEWLINE_BYTE) continue;
        if (onLine(combined.subarray(index + 1, lineEnd).toString('utf8'))) return true;
        lineEnd = index;
      }
      remainder = combined.subarray(0, lineEnd);
    }

    return remainder.length > 0 ? Boolean(onLine(remainder.toString('utf8'))) : false;
  } finally {
    closeSync(fd);
  }
}

/** Scan newline-delimited bytes from oldest to newest with the same accounting. */
export function scanJsonlFileForward(
  path: string,
  options: JsonlScanOptions,
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSync(path, 'r');
  try {
    const claimed = claimFileIdentity(fd, options.stats, options.scannedFileIdentities);
    if (!claimed.claimed || claimed.size <= 0) return false;

    const buffer = Buffer.allocUnsafe(options.chunkBytes);
    let position = 0;
    let remainder = Buffer.alloc(0);

    while (position < claimed.size) {
      const bytesToRead = Math.min(options.chunkBytes, claimed.size - position);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      recordChunkRead(options.stats, bytesRead);

      const combined = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== NEWLINE_BYTE) continue;
        if (onLine(combined.subarray(lineStart, index).toString('utf8'))) return true;
        lineStart = index + 1;
      }
      remainder = combined.subarray(lineStart);
    }

    return remainder.length > 0 ? Boolean(onLine(remainder.toString('utf8'))) : false;
  } finally {
    closeSync(fd);
  }
}
