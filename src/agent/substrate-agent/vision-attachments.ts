import type { ImageContent, UserMessage } from '@mariozechner/pi-ai';
import type { Attachment, SubstrateMessage } from '../../types.js';
import type { LLMProvider } from '../contracts.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import { inferImageMimeTypeFromAttachmentCandidate } from '../substrate-agent-helpers.js';
import { toErrorMessage } from '../../utils/errors.js';

interface VisionAttachmentFetchCapabilities {
  webFetchBinary?: (
    url: string,
    options?: {
      lane?: 'default' | 'local_crawler';
      maxBytes?: number;
    },
  ) => Promise<{
    dataBase64: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

interface VisionLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
  debug: (message: string, payload: Record<string, unknown>) => void;
}

const VISION_ATTACHMENT_MAX_COUNT = 4;
const VISION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const VISION_ATTACHMENT_FETCH_TIMEOUT_MS = 12_000;
const DISCORD_VISION_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);
const DISCORD_VISION_ATTACHMENT_HOST_SUFFIXES = [
  '.discordapp.com',
  '.discordapp.net',
];

export function hasVisionAttachments(message?: SubstrateMessage): boolean {
  if (!message?.attachments || message.attachments.length === 0) return false;
  return message.attachments.some((attachment) => resolveAttachmentImageContentType(attachment) !== null);
}

export async function buildTurnUserContent(input: {
  message: SubstrateMessage;
  llmClient: LLMProvider;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<UserMessage['content']> {
  const imageBlocks = await resolveVisionImageContentBlocks(input);
  if (imageBlocks.length === 0) return input.message.content;

  return [
    { type: 'text', text: input.message.content },
    ...imageBlocks,
  ];
}

function resolveAttachmentImageContentType(attachment: Attachment): string | null {
  const normalizedContentType = attachment.contentType
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (normalizedContentType.startsWith('image/')) {
    return normalizedContentType;
  }

  const candidates = [attachment.name, attachment.url];
  for (const candidate of candidates) {
    const inferred = inferImageMimeTypeFromAttachmentCandidate(candidate);
    if (inferred) return inferred;
  }

  return null;
}

async function resolveVisionImageContentBlocks(input: {
  message: SubstrateMessage;
  llmClient: LLMProvider;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<ImageContent[]> {
  const attachments = input.message.attachments ?? [];
  if (attachments.length === 0) return [];

  const imageAttachments = attachments
    .map((attachment) => ({
      attachment,
      contentType: resolveAttachmentImageContentType(attachment),
    }))
    .filter((entry): entry is { attachment: Attachment; contentType: string } => entry.contentType !== null)
    .slice(0, VISION_ATTACHMENT_MAX_COUNT);
  if (imageAttachments.length === 0) return [];

  const resolved = await Promise.all(
    imageAttachments.map((entry) => resolveVisionAttachmentContent({
      message: input.message,
      attachment: entry.attachment,
      inferredContentType: entry.contentType,
      llmClient: input.llmClient,
      runtimeMode: input.runtimeMode,
      logger: input.logger,
    })),
  );
  const blocks = resolved.filter((block): block is ImageContent => block !== null);
  if (blocks.length === 0) {
    input.logger.warn('Vision image attachments present but none were resolved', {
      channelId: input.message.channelId,
      channelType: input.message.channelType,
      attachmentCount: imageAttachments.length,
      attachmentHosts: imageAttachments.map((entry) => {
        try {
          return new URL(entry.attachment.url).hostname;
        } catch {
          return 'invalid-url';
        }
      }),
    });
  }
  return blocks;
}

async function resolveVisionAttachmentContent(input: {
  message: SubstrateMessage;
  attachment: Attachment;
  inferredContentType: string;
  llmClient: LLMProvider;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<ImageContent | null> {
  if (input.message.channelType !== 'discord') {
    return null;
  }

  let attachmentUrl: URL;
  try {
    attachmentUrl = new URL(input.attachment.url);
  } catch {
    return null;
  }
  if (
    attachmentUrl.protocol !== 'https:'
    || !isAllowedDiscordVisionAttachmentHost(attachmentUrl.hostname)
  ) {
    return null;
  }

  const visionFetchCapabilities = input.llmClient as unknown as VisionAttachmentFetchCapabilities;
  if (typeof visionFetchCapabilities.webFetchBinary === 'function') {
    try {
      const fetched = await visionFetchCapabilities.webFetchBinary(attachmentUrl.toString(), {
        lane: 'default',
        maxBytes: VISION_ATTACHMENT_MAX_BYTES,
      });
      const responseMimeType = fetched.mimeType
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!responseMimeType.startsWith('image/')) {
        return null;
      }
      if (fetched.sizeBytes <= 0 || fetched.sizeBytes > VISION_ATTACHMENT_MAX_BYTES) {
        return null;
      }
      return {
        type: 'image',
        data: fetched.dataBase64,
        mimeType: responseMimeType,
      };
    } catch (error) {
      input.logger.warn('Gateway binary fetch for Discord image attachment failed', {
        channelId: input.message.channelId,
        url: attachmentUrl.toString(),
        error: toErrorMessage(error),
      });
      return null;
    }
  }

  if (input.runtimeMode === 'gateway') {
    input.logger.warn('Skipping Discord image attachment because direct egress is disabled in gateway mode', {
      channelId: input.message.channelId,
      url: attachmentUrl.toString(),
    });
    return null;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), VISION_ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(attachmentUrl.toString(), {
      signal: abortController.signal,
    });
    if (!response.ok) {
      input.logger.debug('Skipping Discord image attachment due to fetch failure', {
        channelId: input.message.channelId,
        status: response.status,
        url: attachmentUrl.toString(),
      });
      return null;
    }

    const reportedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(reportedLength) && reportedLength > VISION_ATTACHMENT_MAX_BYTES) {
      input.logger.debug('Skipping Discord image attachment over byte budget', {
        channelId: input.message.channelId,
        size: reportedLength,
        url: attachmentUrl.toString(),
      });
      return null;
    }

    const responseMimeType = (response.headers.get('content-type') ?? input.inferredContentType)
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!responseMimeType.startsWith('image/')) {
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > VISION_ATTACHMENT_MAX_BYTES) {
      return null;
    }

    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: responseMimeType,
    };
  } catch (error) {
    input.logger.debug('Skipping Discord image attachment due to retrieval error', {
      channelId: input.message.channelId,
      url: attachmentUrl.toString(),
      error: toErrorMessage(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isAllowedDiscordVisionAttachmentHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (DISCORD_VISION_ATTACHMENT_HOSTS.has(normalized)) return true;
  return DISCORD_VISION_ATTACHMENT_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
