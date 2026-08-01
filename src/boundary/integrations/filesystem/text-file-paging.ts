import { open, type FileHandle } from 'node:fs/promises';
import { FILESYSTEM_READ_PAGE_CONTRACT } from '../../../shared/contracts/filesystem.js';
import type { FilesystemReadResult } from './ops.js';

function requireSafeByteInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be a safe integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
}

function utf8CodePointByteLength(leadByte: number): number {
  if (leadByte <= 0x7f) return 1;
  if (leadByte >= 0xc2 && leadByte <= 0xdf) return 2;
  if (leadByte >= 0xe0 && leadByte <= 0xef) return 3;
  if (leadByte >= 0xf0 && leadByte <= 0xf4) return 4;
  return 0;
}

function utf8SafePrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;

  let sequenceStart = buffer.length - 1;
  while (sequenceStart >= 0 && (buffer[sequenceStart]! & 0xc0) === 0x80) {
    sequenceStart -= 1;
  }
  if (sequenceStart < 0) {
    throw new Error('fs read encountered invalid UTF-8 continuation bytes');
  }

  const expectedBytes = utf8CodePointByteLength(buffer[sequenceStart]!);
  if (expectedBytes === 0) {
    throw new Error('fs read encountered invalid UTF-8 input');
  }
  const availableBytes = buffer.length - sequenceStart;
  return availableBytes < expectedBytes ? sequenceStart : buffer.length;
}

function decodeUtf8Page(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('fs read encountered invalid UTF-8 input; only valid UTF-8 text files can be paged');
  }
}

export async function readUtf8TextFilePage(
  path: string,
  maxBytes: number,
  offsetBytes = 0,
): Promise<FilesystemReadResult> {
  const handle = await open(path, 'r');
  try {
    return await readUtf8TextFilePageFromHandle(handle, maxBytes, offsetBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Descriptor-bound form used by security-sensitive scans. The caller owns
 * the handle and can prove its file identity before any bytes are read.
 */
export async function readUtf8TextFilePageFromHandle(
  handle: FileHandle,
  maxBytes: number,
  offsetBytes = 0,
): Promise<FilesystemReadResult> {
  requireSafeByteInteger(
    maxBytes,
    'max_bytes',
    FILESYSTEM_READ_PAGE_CONTRACT.minBytes,
    FILESYSTEM_READ_PAGE_CONTRACT.maxBytes,
  );
  requireSafeByteInteger(offsetBytes, 'offset_bytes', 0, Number.MAX_SAFE_INTEGER);

  const fileStats = await handle.stat();
  if (offsetBytes > fileStats.size) {
    throw new Error(
      `offset_bytes ${String(offsetBytes)} exceeds file size ${String(fileStats.size)} bytes`,
    );
  }
  if (offsetBytes === fileStats.size) {
    return {
      content: '',
      offsetBytes,
      nextOffsetBytes: null,
      eof: true,
      truncated: false,
    };
  }

  if (offsetBytes > 0) {
    const boundaryByte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(boundaryByte, 0, 1, offsetBytes);
    if (bytesRead !== 1) {
      throw new Error(`offset_bytes ${String(offsetBytes)} could not be read`);
    }
    if ((boundaryByte[0]! & 0xc0) === 0x80) {
      throw new Error(
        `offset_bytes ${String(offsetBytes)} is not a UTF-8 character boundary; `
        + 'use the previous page\'s next_offset_bytes value',
      );
    }
  }

  const bytesToRead = Math.min(maxBytes, fileStats.size - offsetBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offsetBytes);
  if (bytesRead === 0) {
    throw new Error(
      `fs read made no progress at offset_bytes ${String(offsetBytes)}; retry the read`,
    );
  }
  const pageBuffer = buffer.subarray(0, bytesRead);
  const safePrefixBytes = utf8SafePrefixLength(pageBuffer);
  if (safePrefixBytes === 0 && bytesRead > 0) {
    const requiredBytes = utf8CodePointByteLength(pageBuffer[0]!);
    throw new Error(
      `max_bytes ${String(maxBytes)} is too small for the next UTF-8 code point`
      + `${requiredBytes > 0 ? ` (${String(requiredBytes)} bytes)` : ''}; increase max_bytes`,
    );
  }

  const contentBuffer = pageBuffer.subarray(0, safePrefixBytes);
  const nextOffsetBytes = offsetBytes + safePrefixBytes;
  const eof = nextOffsetBytes >= fileStats.size;
  return {
    content: decodeUtf8Page(contentBuffer),
    offsetBytes,
    nextOffsetBytes: eof ? null : nextOffsetBytes,
    eof,
    truncated: !eof,
  };
}
