import { createHash } from 'node:crypto';
import type { ContextMessage } from '../../shared/contracts/runtime.js';
import { isObjectRecord as isRecord } from '../../shared/utils/types.js';
import {
  GATEWAY_INLINE_IMAGE_REFERENCE_TYPE,
  type GatewayRetainedImageDescriptor,
} from './inline-image-retention.js';
import type {
  GatewayLLMContentBlock,
  GatewayLLMMessage,
} from './protocol.js';

const GATEWAY_INLINE_IMAGE_HINT_MAX_ENTRIES = 64;

interface GatewayInlineImageHandleHint {
  descriptor: GatewayRetainedImageDescriptor;
}

export interface GatewayReferencedMessages {
  messages: GatewayLLMMessage[];
  usedHintKeys: string[];
}

/**
 * Agent-side references for images already retained by this connection's
 * gateway. Keys are SHA-256 fingerprints, so the bounded cache does not keep
 * another plaintext copy of partner image bytes in memory.
 */
export class GatewayInlineImageReferenceHints {
  private readonly hints = new Map<string, GatewayInlineImageHandleHint>();

  record(input: {
    imageBase64: string;
    mimeType: string;
    requestScope: string;
    descriptor: GatewayRetainedImageDescriptor;
  }): boolean {
    const image = normalizeInlineImage(input.imageBase64, input.mimeType);
    const requestScope = input.requestScope.trim();
    const descriptor = normalizeDescriptor(input.descriptor);
    if (
      !image
      || !requestScope
      || !descriptor
      || descriptor.requestScope !== requestScope
      || descriptor.expiresAt <= Date.now()
    ) {
      return false;
    }

    this.pruneExpired();
    const key = fingerprintInlineImage(image, requestScope);
    this.hints.delete(key);
    this.hints.set(key, { descriptor });
    while (this.hints.size > GATEWAY_INLINE_IMAGE_HINT_MAX_ENTRIES) {
      const oldestKey = this.hints.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.hints.delete(oldestKey);
    }
    return true;
  }

  referenceMessages(
    messages: ContextMessage[],
    requestScope: string | undefined,
  ): GatewayReferencedMessages {
    const scope = requestScope?.trim() ?? '';
    if (!scope) return { messages, usedHintKeys: [] };
    this.pruneExpired();

    const usedHintKeys = new Set<string>();
    const referencedMessages: GatewayLLMMessage[] = [];
    for (const message of messages) {
      const content: unknown = message.content;
      if (!Array.isArray(content)) {
        referencedMessages.push(message);
        continue;
      }
      const wireContent = content as GatewayLLMContentBlock[];
      let changedMessage = false;
      const referencedContent: GatewayLLMContentBlock[] = [];
      for (const block of wireContent) {
        if (block.type !== 'image') {
          referencedContent.push(block);
          continue;
        }
        const image = normalizeInlineImage(block.data, block.mimeType);
        if (!image) {
          referencedContent.push(block);
          continue;
        }
        const key = fingerprintInlineImage(image, scope);
        const hint = this.hints.get(key);
        if (!hint || hint.descriptor.requestScope !== scope) {
          referencedContent.push(block);
          continue;
        }
        changedMessage = true;
        usedHintKeys.add(key);
        referencedContent.push({
          type: GATEWAY_INLINE_IMAGE_REFERENCE_TYPE,
          handle: hint.descriptor.handle,
        });
      }

      referencedMessages.push(changedMessage
        ? { ...message, content: referencedContent }
        : message);
    }

    return {
      messages: usedHintKeys.size > 0 ? referencedMessages : messages,
      usedHintKeys: [...usedHintKeys],
    };
  }

  invalidate(keys: readonly string[]): void {
    for (const key of keys) this.hints.delete(key);
  }

  clear(): void {
    this.hints.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, hint] of this.hints) {
      if (hint.descriptor.expiresAt <= now) this.hints.delete(key);
    }
  }
}

function normalizeDescriptor(value: unknown): GatewayRetainedImageDescriptor | null {
  if (!isRecord(value)) return null;
  const handle = typeof value.handle === 'string' ? value.handle.trim() : '';
  const requestScope = typeof value.requestScope === 'string' ? value.requestScope.trim() : '';
  const expiresAt = value.expiresAt;
  if (!handle || !requestScope || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null;
  }
  return { handle, requestScope, expiresAt };
}

function normalizeInlineImage(data: unknown, mimeType: unknown): {
  dataBase64: string;
  mimeType: string;
} | null {
  const dataBase64 = typeof data === 'string' ? data.replace(/\s+/gu, '') : '';
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!dataBase64 || !normalizedMimeType.startsWith('image/')) return null;
  return { dataBase64, mimeType: normalizedMimeType };
}

function fingerprintInlineImage(
  image: { dataBase64: string; mimeType: string },
  requestScope: string,
): string {
  return createHash('sha256')
    .update(requestScope)
    .update('\0')
    .update(image.mimeType)
    .update('\0')
    .update(image.dataBase64)
    .digest('base64url');
}
