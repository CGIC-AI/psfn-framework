import { randomBytes } from 'node:crypto';
import { isObjectRecord as isRecord } from '../../shared/utils/types.js';
import type {
  GatewayLLMContentBlock,
  GatewayLLMMessage,
  GatewayToolResultContentBlock,
} from './protocol.js';

export const GATEWAY_INLINE_IMAGE_REFERENCE_TYPE = 'gateway_image_ref';
export const GATEWAY_INLINE_IMAGE_RETENTION_TTL_MS = 60_000;
export const GATEWAY_INLINE_IMAGE_RETENTION_MAX_ENTRIES = 12;
export const GATEWAY_INLINE_IMAGE_RETENTION_MAX_BYTES = 32 * 1024 * 1024;

export interface GatewayRetainedImageDescriptor {
  handle: string;
  requestScope: string;
  expiresAt: number;
}

export interface GatewayRetainedImage {
  dataBase64: string;
  mimeType: string;
}

export interface GatewayInlineImageRetentionOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  createHandle?: () => string;
}

export interface GatewayInlineImageRetentionStats {
  entryCount: number;
  decodedBytes: number;
}

interface GatewayRetainedImageEntry extends GatewayRetainedImage {
  descriptor: GatewayRetainedImageDescriptor;
  decodedBytes: number;
}

function isGatewayToolResultContentBlock(
  block: GatewayLLMContentBlock,
): block is GatewayToolResultContentBlock {
  return block.type === 'text'
    || block.type === 'image'
    || block.type === GATEWAY_INLINE_IMAGE_REFERENCE_TYPE;
}

export class GatewayInlineImageRetentionMissError extends Error {
  constructor() {
    super('Gateway inline image retention miss; explicit inline image byte resend is required.');
    this.name = 'GatewayInlineImageRetentionMissError';
  }
}

export class GatewayInlineImageRetention {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly createHandle: () => string;
  private readonly entries = new Map<string, GatewayRetainedImageEntry>();
  private retainedBytes = 0;
  private expirationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GatewayInlineImageRetentionOptions = {}) {
    this.ttlMs = options.ttlMs ?? GATEWAY_INLINE_IMAGE_RETENTION_TTL_MS;
    this.maxEntries = options.maxEntries ?? GATEWAY_INLINE_IMAGE_RETENTION_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? GATEWAY_INLINE_IMAGE_RETENTION_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.createHandle = options.createHandle ?? (() => randomBytes(24).toString('base64url'));
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Gateway inline image retention ttlMs must be a positive integer');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('Gateway inline image retention maxEntries must be a positive integer');
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('Gateway inline image retention maxBytes must be a positive integer');
    }
  }

  retain(input: {
    requestScope: string;
    dataBase64: string;
    mimeType: string;
  }): GatewayRetainedImageDescriptor | null {
    const requestScope = input.requestScope.trim();
    const dataBase64 = input.dataBase64.replace(/\s+/gu, '');
    const mimeType = input.mimeType.trim().toLowerCase();
    if (!requestScope || !dataBase64 || !mimeType.startsWith('image/')) return null;

    const decodedBytes = Buffer.from(dataBase64, 'base64').byteLength;
    if (decodedBytes <= 0 || decodedBytes > this.maxBytes) return null;

    const now = this.now();
    this.pruneExpired(now);
    while (
      this.entries.size >= this.maxEntries
      || this.retainedBytes + decodedBytes > this.maxBytes
    ) {
      const oldestHandle = this.entries.keys().next().value as string | undefined;
      if (oldestHandle === undefined) return null;
      this.deleteEntry(oldestHandle);
    }

    const handle = this.createHandle();
    if (!handle || this.entries.has(handle)) {
      throw new Error('Gateway inline image retention generated a duplicate or empty handle');
    }
    const descriptor = {
      handle,
      requestScope,
      expiresAt: now + this.ttlMs,
    } satisfies GatewayRetainedImageDescriptor;
    this.entries.set(handle, {
      descriptor,
      dataBase64,
      mimeType,
      decodedBytes,
    });
    this.retainedBytes += decodedBytes;
    this.scheduleExpiration(now);
    return descriptor;
  }

  resolve(handle: string, requestScope: string): GatewayRetainedImage | null {
    const now = this.now();
    if (this.pruneExpired(now)) this.scheduleExpiration(now);
    const entry = this.entries.get(handle);
    if (!entry || entry.descriptor.requestScope !== requestScope) return null;
    return {
      dataBase64: entry.dataBase64,
      mimeType: entry.mimeType,
    };
  }

  clear(): void {
    this.cancelExpiration();
    this.entries.clear();
    this.retainedBytes = 0;
  }

  getRetentionStats(): GatewayInlineImageRetentionStats {
    return {
      entryCount: this.entries.size,
      decodedBytes: this.retainedBytes,
    };
  }

  private pruneExpired(now: number): boolean {
    let removed = false;
    for (const [handle, entry] of this.entries) {
      if (entry.descriptor.expiresAt > now) continue;
      this.deleteEntry(handle);
      removed = true;
    }
    return removed;
  }

  private deleteEntry(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.decodedBytes);
  }

  private scheduleExpiration(now: number): void {
    this.cancelExpiration();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      nextExpiry = Math.min(nextExpiry, entry.descriptor.expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;
    this.expirationTimer = setTimeout(() => {
      this.expirationTimer = null;
      const expirationNow = this.now();
      this.pruneExpired(expirationNow);
      this.scheduleExpiration(expirationNow);
    }, Math.max(0, nextExpiry - now));
    this.expirationTimer.unref();
  }

  private cancelExpiration(): void {
    if (!this.expirationTimer) return;
    clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
  }
}

export function resolveGatewayInlineImageReferences(
  messages: GatewayLLMMessage[],
  retention: GatewayInlineImageRetention | undefined,
  requestScope: string | undefined,
): GatewayLLMMessage[] {
  let resolvedCount = 0;
  const resolved: GatewayLLMMessage[] = [];
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) {
      resolved.push(message);
      continue;
    }
    let resolvedMessage = false;
    const resolvedContent: GatewayLLMContentBlock[] = [];
    for (const block of content) {
      const candidate: unknown = block;
      if (!isRecord(candidate) || candidate.type !== GATEWAY_INLINE_IMAGE_REFERENCE_TYPE) {
        resolvedContent.push(block);
        continue;
      }
      const handle = typeof candidate.handle === 'string' ? candidate.handle.trim() : '';
      const scope = requestScope?.trim() ?? '';
      if (!handle || !scope || !retention) throw new GatewayInlineImageRetentionMissError();
      const image = retention.resolve(handle, scope);
      if (!image) throw new GatewayInlineImageRetentionMissError();
      resolvedCount += 1;
      resolvedMessage = true;
      resolvedContent.push({
        type: 'image',
        data: image.dataBase64,
        mimeType: image.mimeType,
      });
    }
    if (!resolvedMessage) {
      resolved.push(message);
      continue;
    }
    if (message.role === 'toolResult') {
      if (!resolvedContent.every(isGatewayToolResultContentBlock)) {
        throw new Error('Gateway tool-result content widened outside its canonical wire contract');
      }
      resolved.push({ ...message, content: resolvedContent });
      continue;
    }
    resolved.push({ ...message, content: resolvedContent });
  }
  return resolvedCount > 0 ? resolved : messages;
}
