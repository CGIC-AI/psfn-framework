import { randomBytes } from 'node:crypto';
import type { ContextMessage } from '../../shared/contracts/runtime.js';
import { isObjectRecord as isRecord } from '../../shared/utils/types.js';

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

interface GatewayRetainedImageEntry extends GatewayRetainedImage {
  descriptor: GatewayRetainedImageDescriptor;
  decodedBytes: number;
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
    return descriptor;
  }

  resolve(handle: string, requestScope: string): GatewayRetainedImage | null {
    const now = this.now();
    this.pruneExpired(now);
    const entry = this.entries.get(handle);
    if (!entry || entry.descriptor.requestScope !== requestScope) return null;
    return {
      dataBase64: entry.dataBase64,
      mimeType: entry.mimeType,
    };
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  private pruneExpired(now: number): void {
    for (const [handle, entry] of this.entries) {
      if (entry.descriptor.expiresAt <= now) this.deleteEntry(handle);
    }
  }

  private deleteEntry(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.decodedBytes);
  }
}

export function resolveGatewayInlineImageReferences(
  messages: ContextMessage[],
  retention: GatewayInlineImageRetention | undefined,
  requestScope: string | undefined,
): ContextMessage[] {
  let resolvedAny = false;
  const resolved = messages.map((message) => {
    const content = (message as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let resolvedMessage = false;
    const resolvedContent = content.map((block) => {
      if (!isRecord(block) || block.type !== GATEWAY_INLINE_IMAGE_REFERENCE_TYPE) return block;
      const handle = typeof block.handle === 'string' ? block.handle.trim() : '';
      const scope = requestScope?.trim() ?? '';
      if (!handle || !scope || !retention) throw new GatewayInlineImageRetentionMissError();
      const image = retention.resolve(handle, scope);
      if (!image) throw new GatewayInlineImageRetentionMissError();
      resolvedAny = true;
      resolvedMessage = true;
      return {
        type: 'image',
        data: image.dataBase64,
        mimeType: image.mimeType,
      };
    });
    if (!resolvedMessage) return message;
    return { ...message, content: resolvedContent } as unknown as ContextMessage;
  });
  return resolvedAny ? resolved : messages;
}
