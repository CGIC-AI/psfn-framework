import type { Message } from 'discord.js';
import type { Attachment } from '../../shared/contracts/runtime.js';
import {
  toDiscordDocumentAttachmentCandidate,
  type DiscordDocumentAttachmentCandidate,
} from './file-ingest.js';
import { hasDiscordAttachmentMetadataQuarantineRisk } from './file-quarantine.js';

export const DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 4;

const DISCORD_MAX_DOCUMENT_ATTACHMENTS_PER_MESSAGE = 4;
const DISCORD_MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DISCORD_INLINE_IMAGE_URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const DISCORD_IMAGE_LINK_HOST_SUFFIXES = [
  '.discordapp.com',
  '.discordapp.net',
];
const DISCORD_IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

interface DiscordAttachmentLogger {
  debug(message: string, metadata: Record<string, unknown>): void;
}

export function extractDiscordImageAttachments(
  msg: Message,
  logger: DiscordAttachmentLogger,
): Attachment[] {
  const rawAttachments = msg.attachments.values();

  const attachments: Attachment[] = [];
  for (const raw of rawAttachments) {
    if (attachments.length >= DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) break;
    if (hasDiscordAttachmentMetadataQuarantineRisk(raw)) {
      logger.debug('Skipping metadata-risky Discord image attachment until quarantine review', {
        channelId: msg.channelId,
        messageId: msg.id,
        name: raw.name,
        contentType: raw.contentType,
      });
      continue;
    }

    const contentType = resolveDiscordImageContentType(raw);
    if (!contentType) continue;

    const size = typeof raw.size === 'number' && Number.isFinite(raw.size)
      ? Math.max(0, Math.trunc(raw.size))
      : 0;
    if (size > DISCORD_MAX_IMAGE_ATTACHMENT_BYTES) {
      logger.debug('Skipping oversized Discord image attachment', {
        channelId: msg.channelId,
        messageId: msg.id,
        name: raw.name,
        size,
      });
      continue;
    }

    // Prefer the canonical CDN URL over Discord's transient proxy URL.
    // The proxy can 404 immediately after upload, which breaks vision fetches.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- discord.js types claim non-null but mocks/edge cases disagree
    const url = (raw.url ?? raw.proxyURL ?? '').trim();
    if (!url) continue;

    attachments.push({
      url,
      contentType,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive for partial mock data
      name: raw.name ?? `attachment-${raw.id ?? attachments.length + 1}`,
    });
  }

  return attachments;
}

export function extractDiscordDocumentAttachmentCandidates(
  msg: Message,
): DiscordDocumentAttachmentCandidate[] {
  const candidates: DiscordDocumentAttachmentCandidate[] = [];
  for (const raw of msg.attachments.values()) {
    if (candidates.length >= DISCORD_MAX_DOCUMENT_ATTACHMENTS_PER_MESSAGE) break;
    const candidate = toDiscordDocumentAttachmentCandidate(raw);
    if (!candidate) continue;
    candidates.push(candidate);
  }
  return candidates;
}

export function extractDiscordInlineImageLinks(
  content: string,
  seenUrls: Set<string>,
  remaining: number,
): Attachment[] {
  if (!content || remaining <= 0) return [];
  const attachments: Attachment[] = [];
  const matches = content.matchAll(DISCORD_INLINE_IMAGE_URL_PATTERN);
  for (const match of matches) {
    if (attachments.length >= remaining) break;
    const normalizedUrl = normalizeInlineUrl(match[0]);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
    if (!isDiscordHostedImageUrl(normalizedUrl)) continue;
    const contentType = inferImageMimeTypeFromCandidate(normalizedUrl);
    if (!contentType) continue;

    attachments.push({
      url: normalizedUrl,
      contentType,
      name: inferFileNameFromUrl(normalizedUrl) ?? `attachment-inline-${attachments.length + 1}`,
    });
    seenUrls.add(normalizedUrl);
  }
  return attachments;
}

function resolveDiscordImageContentType(raw: {
  contentType?: string | null;
  name?: string | null;
  url?: string | null;
  proxyURL?: string | null;
  width?: number | null;
  height?: number | null;
}): string | null {
  const normalizedContentType = raw.contentType?.trim().toLowerCase();
  if (normalizedContentType?.startsWith('image/')) {
    return normalizedContentType;
  }

  const candidates = [raw.name, raw.url, raw.proxyURL];
  for (const candidate of candidates) {
    const inferred = inferImageMimeTypeFromCandidate(candidate);
    if (inferred) return inferred;
  }

  const hasDimensions = typeof raw.width === 'number'
    && Number.isFinite(raw.width)
    && raw.width > 0
    && typeof raw.height === 'number'
    && Number.isFinite(raw.height)
    && raw.height > 0;
  if (hasDimensions) {
    return 'image/png';
  }

  return null;
}

function inferImageMimeTypeFromCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let value = trimmed;
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      value = new URL(trimmed).pathname;
    }
  } catch {
    value = trimmed;
  }

  const lower = value.toLowerCase();
  for (const [extension, mimeType] of Object.entries(DISCORD_IMAGE_EXTENSION_TO_MIME)) {
    if (lower.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}

function normalizeInlineUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutTrailingPunctuation = trimmed.replace(/[),.!?:;]+$/g, '');
  if (!withoutTrailingPunctuation) return null;
  try {
    const parsed = new URL(withoutTrailingPunctuation);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isDiscordHostedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return DISCORD_IMAGE_LINK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function inferFileNameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const fileName = parts.at(-1)?.trim();
    return fileName && fileName.length > 0 ? fileName : null;
  } catch {
    return null;
  }
}
