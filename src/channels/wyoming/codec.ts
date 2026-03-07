import {
  WyomingCodecError,
  type WyomingFrame,
  type WyomingJsonObject,
  isRecord,
} from './protocol.js';

const HEADER_DELIMITER = '\n\n';
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = DEFAULT_MAX_HEADER_BYTES + DEFAULT_MAX_PAYLOAD_BYTES;
const RESERVED_HEADERS = new Set(['type', 'data', 'payload_length']);

export interface WyomingFrameCodecOptions {
  maxHeaderBytes?: number;
  maxPayloadBytes?: number;
  maxFrameBytes?: number;
}

function resolveBound(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new WyomingCodecError('INVALID_HEADER', `${field} must be a positive integer`);
  }
  return value;
}

function normalizeHeaderName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new WyomingCodecError('INVALID_HEADER', 'Header name is required');
  }

  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new WyomingCodecError('INVALID_HEADER', `Invalid header name: ${name}`);
  }

  return normalized;
}

function ensureHeaderValue(value: string, key: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new WyomingCodecError('INVALID_HEADER', `Header ${key} contains newline characters`);
  }

  return value.trim();
}

function parseDataHeader(raw: string): WyomingJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WyomingCodecError('INVALID_DATA', `Failed to parse data header JSON: ${String(error)}`);
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new WyomingCodecError('INVALID_DATA', 'data header must encode a JSON object');
  }

  return parsed as WyomingJsonObject;
}

function parseHeaderBlock(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = block.split('\n');

  for (const line of lines) {
    const cleaned = line.trimEnd();
    if (!cleaned) {
      continue;
    }

    const separatorIndex = cleaned.indexOf(':');
    if (separatorIndex <= 0) {
      throw new WyomingCodecError('INVALID_HEADER', `Malformed header line: ${cleaned}`);
    }

    const key = normalizeHeaderName(cleaned.slice(0, separatorIndex));
    if (headers.has(key)) {
      throw new WyomingCodecError('INVALID_HEADER', `Duplicate header: ${key}`);
    }

    const value = ensureHeaderValue(cleaned.slice(separatorIndex + 1), key);
    headers.set(key, value);
  }

  if (!headers.has('type')) {
    throw new WyomingCodecError('INVALID_HEADER', 'Header "type" is required');
  }

  return headers;
}

function parsePayloadLength(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return 0;
  }

  if (!/^\d+$/.test(raw)) {
    throw new WyomingCodecError('INVALID_PAYLOAD_LENGTH', `payload_length must be a non-negative integer, got ${raw}`);
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new WyomingCodecError('INVALID_PAYLOAD_LENGTH', `payload_length is too large: ${raw}`);
  }

  return parsed;
}

function toBuffer(chunk: Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  return Buffer.from(chunk);
}

function pushChunk(existing: Buffer<ArrayBufferLike>, chunk: Uint8Array): Buffer<ArrayBufferLike> {
  if (chunk.byteLength === 0) {
    return existing;
  }

  const asBuffer = toBuffer(chunk);
  if (existing.byteLength === 0) {
    return Buffer.from(asBuffer);
  }

  return Buffer.concat([existing, asBuffer]);
}

export class WyomingFrameCodec {
  private readonly maxHeaderBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly maxFrameBytes: number;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(options: WyomingFrameCodecOptions = {}) {
    this.maxHeaderBytes = resolveBound(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 'maxHeaderBytes');
    this.maxPayloadBytes = resolveBound(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 'maxPayloadBytes');
    this.maxFrameBytes = resolveBound(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes');

    const minFrameBytes = this.maxHeaderBytes + 2;
    if (this.maxFrameBytes < minFrameBytes) {
      throw new WyomingCodecError('INVALID_HEADER', `maxFrameBytes must be at least ${minFrameBytes}`);
    }
  }

  push(chunk: Uint8Array): WyomingFrame[] {
    this.buffer = pushChunk(this.buffer, chunk);
    return this.drain();
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  encode(frame: WyomingFrame): Buffer {
    const type = frame.type.trim();
    if (!type) {
      throw new WyomingCodecError('INVALID_HEADER', 'Frame type is required');
    }

    if (type.includes('\n') || type.includes('\r')) {
      throw new WyomingCodecError('INVALID_HEADER', 'Frame type cannot contain newlines');
    }

    const payload = frame.payload && frame.payload.byteLength > 0
      ? Buffer.from(frame.payload)
      : Buffer.alloc(0);

    if (payload.byteLength > this.maxPayloadBytes) {
      throw new WyomingCodecError(
        'PAYLOAD_TOO_LARGE',
        `Payload exceeds maxPayloadBytes (${payload.byteLength} > ${this.maxPayloadBytes})`,
      );
    }

    const headerEntries: Array<[string, string]> = [['type', type]];

    if (frame.data !== undefined) {
      const serializedData = JSON.stringify(frame.data);
      headerEntries.push(['data', ensureHeaderValue(serializedData, 'data')]);
    }

    if (payload.byteLength > 0) {
      headerEntries.push(['payload_length', String(payload.byteLength)]);
    }

    if (frame.headers) {
      for (const [rawKey, rawValue] of Object.entries(frame.headers)) {
        const key = normalizeHeaderName(rawKey);
        if (RESERVED_HEADERS.has(key)) {
          continue;
        }

        const value = ensureHeaderValue(String(rawValue), key);
        headerEntries.push([key, value]);
      }
    }

    const serializedHeaders = `${headerEntries.map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n`;
    const headerBuffer = Buffer.from(serializedHeaders, 'utf8');

    if (headerBuffer.byteLength > this.maxHeaderBytes) {
      throw new WyomingCodecError(
        'HEADER_TOO_LARGE',
        `Serialized headers exceed maxHeaderBytes (${headerBuffer.byteLength} > ${this.maxHeaderBytes})`,
      );
    }

    const frameByteLength = headerBuffer.byteLength + payload.byteLength;
    if (frameByteLength > this.maxFrameBytes) {
      throw new WyomingCodecError(
        'FRAME_TOO_LARGE',
        `Frame exceeds maxFrameBytes (${frameByteLength} > ${this.maxFrameBytes})`,
      );
    }

    if (payload.byteLength === 0) {
      return headerBuffer;
    }

    return Buffer.concat([headerBuffer, payload]);
  }

  private drain(): WyomingFrame[] {
    const frames: WyomingFrame[] = [];

    for (;;) {
      const delimiterIndex = this.buffer.indexOf(HEADER_DELIMITER);
      if (delimiterIndex === -1) {
        if (this.buffer.byteLength > this.maxHeaderBytes) {
          throw new WyomingCodecError(
            'HEADER_TOO_LARGE',
            `Header bytes exceeded limit before delimiter (${this.buffer.byteLength} > ${this.maxHeaderBytes})`,
          );
        }
        return frames;
      }

      const headerBytes = delimiterIndex + HEADER_DELIMITER.length;
      if (headerBytes > this.maxHeaderBytes) {
        throw new WyomingCodecError(
          'HEADER_TOO_LARGE',
          `Header block exceeds maxHeaderBytes (${headerBytes} > ${this.maxHeaderBytes})`,
        );
      }

      const headerBlock = this.buffer.subarray(0, delimiterIndex).toString('utf8');
      const headers = parseHeaderBlock(headerBlock);
      const payloadLength = parsePayloadLength(headers.get('payload_length'));

      if (payloadLength > this.maxPayloadBytes) {
        throw new WyomingCodecError(
          'PAYLOAD_TOO_LARGE',
          `Payload exceeds maxPayloadBytes (${payloadLength} > ${this.maxPayloadBytes})`,
        );
      }

      const frameByteLength = headerBytes + payloadLength;
      if (frameByteLength > this.maxFrameBytes) {
        throw new WyomingCodecError(
          'FRAME_TOO_LARGE',
          `Frame exceeds maxFrameBytes (${frameByteLength} > ${this.maxFrameBytes})`,
        );
      }

      if (this.buffer.byteLength < frameByteLength) {
        return frames;
      }

      const payload = payloadLength > 0
        ? new Uint8Array(this.buffer.subarray(headerBytes, frameByteLength))
        : undefined;

      const frame = this.toFrame(headers, payload);
      frames.push(frame);

      if (this.buffer.byteLength === frameByteLength) {
        this.buffer = Buffer.alloc(0);
      } else {
        this.buffer = Buffer.from(this.buffer.subarray(frameByteLength));
      }
    }
  }

  private toFrame(headers: Map<string, string>, payload?: Uint8Array): WyomingFrame {
    const type = headers.get('type');
    if (!type) {
      throw new WyomingCodecError('INVALID_HEADER', 'Header "type" is required');
    }

    const dataHeader = headers.get('data');
    const data = dataHeader !== undefined ? parseDataHeader(dataHeader) : undefined;

    const extraHeaders: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
      if (RESERVED_HEADERS.has(key)) {
        continue;
      }
      extraHeaders[key] = value;
    }

    return {
      type,
      data,
      payload,
      headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    };
  }
}

export function createWyomingFrameCodec(options: WyomingFrameCodecOptions = {}): WyomingFrameCodec {
  return new WyomingFrameCodec(options);
}
