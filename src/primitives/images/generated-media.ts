import { isRecord } from '../../shared/utils/types.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Attachment } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { resolveGeneratedImagesDir } from '../../persistence/layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type {
  ImageGenerationResult,
  ImageResultAsset,
  MediaToolResultDetails,
  ImageToolResultDetails,
} from './types.js';

const log = createComponentLogger('ImageGeneratedMedia');
// Retired names stay here only so old turn records can still attach generated files.
const IMAGE_TOOL_NAMES = new Set(['media', 'image_create', 'selfie_create', 'image_edit']);
const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';

export interface GeneratedImageGalleryContext {
  channelId?: string;
  channelType?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  userSessionEntryId?: number;
  assistantSessionEntryId?: number;
}

interface CollectedImageGenerationResult {
  message: AgentMessage & {
    role: 'toolResult';
    toolName: string;
    toolCallId?: string;
    details?: unknown;
    isError?: boolean;
    content: unknown;
  };
  result: ImageGenerationResult;
}


function isToolResultMessage(message: AgentMessage): message is AgentMessage & {
  role: 'toolResult';
  toolName: string;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
  content: unknown;
} {
  return (message as { role?: string }).role === 'toolResult';
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const text = content
    .filter((entry): entry is { type: string; text: string } => (
      isRecord(entry)
      && entry.type === 'text'
      && typeof entry.text === 'string'
    ))
    .map((entry) => entry.text)
    .join('');

  return text;
}

function normalizeImageGenerationResult(parsed: unknown): ImageGenerationResult | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.images)) {
    return null;
  }

  const images = parsed.images
    .filter((entry): entry is ImageResultAsset => isRecord(entry) && typeof entry.url === 'string')
    .map((entry) => ({
      url: entry.url.trim(),
      ...(typeof entry.contentType === 'string' && entry.contentType.trim()
        ? { contentType: entry.contentType.trim() }
        : {}),
      ...(typeof entry.fileName === 'string' && entry.fileName.trim()
        ? { fileName: entry.fileName.trim() }
        : {}),
      ...(typeof entry.localPath === 'string' && entry.localPath.trim()
        ? { localPath: entry.localPath.trim() }
        : {}),
    }))
    .filter((entry) => entry.url.length > 0);

  if (images.length === 0) {
    return null;
  }

  return {
    provider: parsed.provider === 'comfyui' ? 'comfyui' : 'fal',
    mode: parsed.mode === 'edit' ? 'edit' : 'create',
    model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined,
    fallbackUsed: parsed.fallbackUsed === true,
    fallbackReason: typeof parsed.fallbackReason === 'string' && parsed.fallbackReason.trim()
      ? parsed.fallbackReason.trim()
      : undefined,
    requestId: typeof parsed.requestId === 'string' && parsed.requestId.trim() ? parsed.requestId.trim() : undefined,
    images,
  };
}

function parseImageGenerationResult(rawText: string): ImageGenerationResult | null {
  const text = rawText.trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return normalizeImageGenerationResult(parsed);
}

function resolveImageResultFromDetails(details: unknown): ImageGenerationResult | null {
  if (!isRecord(details)) {
    return null;
  }
  const mediaResult = normalizeImageGenerationResult((details as MediaToolResultDetails).mediaResult);
  if (mediaResult) {
    return mediaResult;
  }
  return normalizeImageGenerationResult((details as ImageToolResultDetails).imageResult);
}

function inferExtension(url: string, contentType: string | undefined): string {
  const normalizedType = (contentType ?? '').trim().toLowerCase();
  if (normalizedType.startsWith('image/png')) return '.png';
  if (normalizedType.startsWith('image/jpeg')) return '.jpg';
  if (normalizedType.startsWith('image/webp')) return '.webp';
  if (normalizedType.startsWith('image/gif')) return '.gif';
  if (normalizedType.startsWith('image/bmp')) return '.bmp';
  if (normalizedType.startsWith('image/tiff')) return '.tiff';

  try {
    const candidate = extname(new URL(url).pathname).trim().toLowerCase();
    if (candidate) {
      return candidate;
    }
  } catch {
    // Fall through to default extension.
  }

  return '.png';
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'image';
}

function deriveFileStem(asset: ImageResultAsset, requestId: string | undefined, index: number): string {
  const fromAsset = asset.fileName?.trim();
  if (fromAsset) {
    const name = basename(fromAsset, extname(fromAsset));
    return sanitizeFileStem(name);
  }
  if (requestId) {
    return sanitizeFileStem(`${requestId}-${index + 1}`);
  }
  return `image-${index + 1}`;
}

function resolveAttachmentName(storedPath: string, asset: ImageResultAsset): string {
  const fileName = asset.fileName?.trim();
  if (fileName) return basename(fileName);
  return basename(storedPath);
}

async function persistImageAsset(params: {
  asset: ImageResultAsset;
  requestId?: string;
  index: number;
  storageDir: string;
  fetchImpl: typeof fetch;
}): Promise<Attachment> {
  const { asset, requestId, index, storageDir, fetchImpl } = params;
  const extension = inferExtension(asset.url, asset.contentType);
  const fileStem = deriveFileStem(asset, requestId, index);
  const existingLocalPath = asset.localPath?.trim();
  if (existingLocalPath) {
    return {
      url: asset.url,
      contentType: asset.contentType || 'image/png',
      name: resolveAttachmentName(existingLocalPath, asset),
      localPath: existingLocalPath,
    };
  }
  const fileName = `${fileStem}-${randomUUID().slice(0, 8)}${extension}`;
  const storedPath = join(storageDir, fileName);

  try {
    const response = await fetchImpl(asset.url);
    if (!response.ok) {
      throw new Error(`download failed with ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(storedPath, buffer);
    const responseContentType = response.headers.get('content-type')?.trim() || undefined;
    return {
      url: asset.url,
      contentType: responseContentType || asset.contentType || 'image/png',
      name: resolveAttachmentName(storedPath, asset),
      localPath: storedPath,
    };
  } catch (error) {
    log.warn('Failed to persist generated image locally; keeping remote asset only', {
      url: asset.url,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      url: asset.url,
      contentType: asset.contentType || 'image/png',
      name: asset.fileName?.trim() || `${fileStem}${extension}`,
    };
  }
}

async function readExistingMetadata(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(`${path}${GENERATED_IMAGE_META_SUFFIX}`, 'utf-8')) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // New generated image artifacts normally do not have sidecars yet.
  }
  return {};
}

function cleanContext(context: GeneratedImageGalleryContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const clean: Record<string, unknown> = {};
  for (const key of ['channelId', 'channelType', 'turnId', 'requestId', 'sourceMessageId'] as const) {
    const value = context[key];
    if (typeof value === 'string' && value.trim()) clean[key] = value.trim();
  }
  if (typeof context.userSessionEntryId === 'number' && Number.isFinite(context.userSessionEntryId)) {
    clean.userSessionEntryId = Math.floor(context.userSessionEntryId);
  }
  if (typeof context.assistantSessionEntryId === 'number' && Number.isFinite(context.assistantSessionEntryId)) {
    clean.assistantSessionEntryId = Math.floor(context.assistantSessionEntryId);
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

async function writeGeneratedImageGalleryMetadata(params: {
  localPath: string;
  asset: ImageResultAsset;
  attachment: Attachment;
  result: ImageGenerationResult;
  message: CollectedImageGenerationResult['message'];
  index: number;
  context?: GeneratedImageGalleryContext;
}): Promise<void> {
  const { localPath, asset, attachment, result, message, index, context } = params;
  const existing = await readExistingMetadata(localPath);
  const conversation = cleanContext(context);
  const contentType = attachment.contentType || asset.contentType || 'image/png';
  const artifactRefId = result.requestId || message.toolCallId || attachment.name;
  const base: Record<string, unknown> = {
    ...existing,
    schemaVersion: 1,
    createdAt: typeof existing.createdAt === 'string' && existing.createdAt.trim()
      ? existing.createdAt
      : new Date().toISOString(),
    provider: result.provider,
    mode: result.mode,
    ...(result.model ? { model: result.model } : {}),
    fallbackUsed: result.fallbackUsed,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    imageIndex: index,
    originalUrl: asset.url,
    contentType,
    ...(asset.fileName ? { providerFileName: asset.fileName } : {}),
    sourceToolName: message.toolName,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(conversation ? { conversation } : {}),
    artifactRefs: [
      ...(
        Array.isArray(existing.artifactRefs)
          ? existing.artifactRefs
          : []
      ),
      {
        kind: 'shared_image',
        refId: artifactRefId,
        url: asset.url,
        localPath,
      },
    ],
  };
  writeJsonAtomic(`${localPath}${GENERATED_IMAGE_META_SUFFIX}`, base);
}

export async function collectGeneratedImageAttachments(params: {
  turnMessages: AgentMessage[];
  companionDataDir: string;
  fetchImpl?: typeof fetch;
  galleryContext?: GeneratedImageGalleryContext;
}): Promise<Attachment[]> {
  const imageResults = params.turnMessages
    .filter((message): message is AgentMessage & {
      role: 'toolResult';
      toolName: string;
      toolCallId?: string;
      details?: unknown;
      isError?: boolean;
      content: unknown;
    } => isToolResultMessage(message))
    .filter((message) => IMAGE_TOOL_NAMES.has(message.toolName))
    .filter((message) => message.isError !== true)
    .map((message): CollectedImageGenerationResult | null => {
      const result = resolveImageResultFromDetails(message.details)
        ?? parseImageGenerationResult(extractToolResultText(message.content));
      return result ? { message, result } : null;
    })
    .filter((entry): entry is CollectedImageGenerationResult => entry !== null);

  if (imageResults.length === 0) {
    return [];
  }

  const needsStorage = imageResults.some(result => (
    result.result.images.some(asset => !asset.localPath?.trim())
  ));
  let storageDir = '';
  if (needsStorage) {
    const now = new Date();
    const dateDir = [
      now.getUTCFullYear().toString().padStart(4, '0'),
      (now.getUTCMonth() + 1).toString().padStart(2, '0'),
      now.getUTCDate().toString().padStart(2, '0'),
    ].join('-');
    storageDir = join(resolveGeneratedImagesDir(params.companionDataDir), dateDir);
    await mkdir(storageDir, { recursive: true });
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const attachments: Attachment[] = [];
  for (const { message, result } of imageResults) {
    for (const [index, asset] of result.images.entries()) {
      const attachment = await persistImageAsset({
        asset,
        requestId: result.requestId,
        index,
        storageDir,
        fetchImpl,
      });
      attachments.push(attachment);
      if (attachment.localPath?.trim()) {
        try {
          await writeGeneratedImageGalleryMetadata({
            localPath: attachment.localPath,
            asset,
            attachment,
            result,
            message,
            index,
            context: params.galleryContext,
          });
        } catch (error) {
          log.warn('Failed to write generated image gallery sidecar', {
            localPath: attachment.localPath,
            requestId: result.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return attachments;
}
