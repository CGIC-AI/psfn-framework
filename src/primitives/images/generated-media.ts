import { isRecord } from '../../shared/utils/types.js';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import type { Attachment } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isStrictSubpath, resolvePersonalImagesDir } from '../../persistence/layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type {
  ImageGenerationResult,
  ImageResultAsset,
  MediaToolResultDetails,
  ImageToolResultDetails,
} from './types.js';
import type {
  PendingPaidDeliverable,
  PendingPaidDeliverableArtifact,
} from '../../shared/paid-deliverable-tracking.js';
import {
  classifyArtifactSensitivity,
  parseArtifactSensitivityClassification,
  type ArtifactSensitivityClassification,
  type ArtifactSensitivitySource,
} from '../../shared/contracts/artifact-sensitivity.js';
import {
  buildImageFileName,
  deriveImageFileStem,
  inferImageExtension,
} from './file-naming.js';

const log = createComponentLogger('ImageGeneratedMedia');
// Live tool names first; retired names ('media', 'image_create', 'image_edit')
// stay here only so old turn records can still attach generated files.
const IMAGE_TOOL_NAMES = new Set(['generate_image', 'selfie_create', 'media', 'image_create', 'image_edit']);
const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';

export interface GeneratedImageGalleryContext {
  channelId?: string;
  channelType?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  userSessionEntryId?: number;
  assistantSessionEntryId?: number;
  /** Content-free sources actually present in the context used to create the image. */
  sensitivitySources?: readonly ArtifactSensitivitySource[];
  /** Precomputed once so the durable sidecar and egress approval fingerprint are identical. */
  sensitivityClassification?: ArtifactSensitivityClassification;
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

function normalizeImageMode(value: unknown): ImageGenerationResult['mode'] {
  return value === 'edit' ? 'edit' : 'create';
}

function normalizeImageProvider(value: unknown): ImageGenerationResult['provider'] {
  return value === 'comfyui' ? 'comfyui' : 'fal';
}

function collectImageResultKey(entry: CollectedImageGenerationResult): string {
  const requestId = entry.result.requestId?.trim();
  if (requestId) return `request:${requestId}`;
  const toolCallIdValue = (entry.message as { toolCallId?: unknown }).toolCallId;
  const toolCallId = typeof toolCallIdValue === 'string' ? toolCallIdValue.trim() : '';
  if (toolCallId) return `tool:${toolCallId}`;
  return `assets:${entry.message.toolName}:${
    entry.result.images.map((asset) => asset.localPath?.trim() || asset.url.trim()).join('|')
  }`;
}

function collectImageResultUnique(
  entries: CollectedImageGenerationResult[],
  seen: Set<string>,
  entry: CollectedImageGenerationResult | null,
): void {
  if (!entry) return;
  const key = collectImageResultKey(entry);
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function imageResultFromPendingDeliverable(
  deliverable: PendingPaidDeliverable,
): CollectedImageGenerationResult | null {
  if (deliverable.surface !== 'paidImageGeneration') return null;
  if (deliverable.artifactKind !== 'image') return null;
  const toolName = deliverable.toolName?.trim();
  if (!toolName || !IMAGE_TOOL_NAMES.has(toolName)) return null;

  const images = (deliverable.artifacts ?? [])
    .filter((artifact): artifact is PendingPaidDeliverableArtifact => (
      artifact.url.trim().length > 0
    ))
    .map((artifact): ImageResultAsset => ({
      url: artifact.url.trim(),
      ...(artifact.contentType?.trim() ? { contentType: artifact.contentType.trim() } : {}),
      ...(artifact.fileName?.trim() ? { fileName: artifact.fileName.trim() } : {}),
      ...(artifact.localPath?.trim() ? { localPath: artifact.localPath.trim() } : {}),
    }));
  if (images.length === 0) return null;

  const result: ImageGenerationResult = {
    provider: normalizeImageProvider(deliverable.provider),
    mode: normalizeImageMode(deliverable.mode),
    ...(deliverable.model?.trim() ? { model: deliverable.model.trim() } : {}),
    fallbackUsed: false,
    ...(deliverable.identifier?.trim() ? { requestId: deliverable.identifier.trim() } : {}),
    images,
  };
  return {
    message: {
      role: 'toolResult',
      toolName,
      ...(deliverable.toolCallId?.trim() ? { toolCallId: deliverable.toolCallId.trim() } : {}),
      content: [],
      details: { imageResult: result },
      isError: false,
    },
    result,
  };
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
  const extension = inferImageExtension(asset.url, asset.contentType);
  const fileStem = deriveImageFileStem(asset, requestId, index);
  const existingLocalPath = asset.localPath?.trim();
  if (existingLocalPath) {
    return {
      url: asset.url,
      contentType: asset.contentType || 'image/png',
      name: resolveAttachmentName(existingLocalPath, asset),
      localPath: existingLocalPath,
    };
  }
  const fileName = buildImageFileName(asset, requestId, index);
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

const EMBODIMENT_VERDICTS = new Set(['same_me', 'drifted', 'different_person']);

/**
 * Lift the embodiment-consistency descriptor off a tool-result's vision review
 * so it is durably recorded on the gallery sidecar. Content-free: verdict,
 * framing, and the model's short note only.
 */
function embodimentFromToolDetails(details: unknown): Record<string, unknown> | undefined {
  if (!isRecord(details)) return undefined;
  const review = details.visionReview;
  if (!isRecord(review)) return undefined;
  const embodiment = review.embodiment;
  if (!isRecord(embodiment)) return undefined;
  const verdict = typeof embodiment.verdict === 'string' ? embodiment.verdict : '';
  if (!EMBODIMENT_VERDICTS.has(verdict)) return undefined;
  const referenceId = typeof embodiment.referenceId === 'string' ? embodiment.referenceId.trim() : '';
  const framing = typeof embodiment.framing === 'string' ? embodiment.framing.trim() : '';
  const note = typeof embodiment.note === 'string' ? embodiment.note.trim() : '';
  const referenceDescription = typeof embodiment.referenceDescription === 'string'
    ? embodiment.referenceDescription.trim()
    : '';
  return {
    verdict,
    ...(framing ? { framing } : {}),
    ...(note ? { note } : {}),
    ...(referenceId ? { referenceId } : {}),
    ...(referenceDescription ? { referenceDescription } : {}),
    reviewedAt: new Date().toISOString(),
  };
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
  const embodiment = embodimentFromToolDetails(message.details);
  const sensitivityClassification = context?.sensitivityClassification
    ?? classifyArtifactSensitivity(context?.sensitivitySources ?? []);
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
    ...(embodiment ? { embodiment } : {}),
    sensitivityClassification,
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

export async function readGeneratedImageSensitivityClassifications(
  attachments: readonly Attachment[],
): Promise<ArtifactSensitivityClassification[]> {
  const classifications: ArtifactSensitivityClassification[] = [];
  for (const attachment of attachments) {
    const localPath = attachment.localPath?.trim();
    if (!localPath) {
      throw new Error('Artifact sensitivity verification requires a persisted local image');
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(`${localPath}${GENERATED_IMAGE_META_SUFFIX}`, 'utf-8'));
    } catch (error) {
      throw new Error(`Artifact sensitivity metadata is unavailable: ${String(error)}`);
    }
    if (!isRecord(metadata)) {
      throw new Error('Artifact sensitivity metadata must be a JSON object');
    }
    const classification = parseArtifactSensitivityClassification(metadata.sensitivityClassification);
    if (!classification) {
      throw new Error('Artifact sensitivity metadata is missing or invalid');
    }
    classifications.push(classification);
  }
  return classifications;
}

export interface ChargedImageDeliverableSummary {
  toolName: string;
  toolCallId?: string;
  requestId?: string;
  imageCount: number;
}

/**
 * Identify paid (fal-provider) image deliverables present in a turn's messages.
 * Free local providers (comfyui) are excluded: only charged surfaces represent
 * spend that must not be silently dropped. Used at turn finalization to detect a
 * paid artifact that never reached the outbound reply.
 */
export function summarizeChargedImageDeliverables(
  turnMessages: AgentMessage[],
): ChargedImageDeliverableSummary[] {
  const summaries: ChargedImageDeliverableSummary[] = [];
  for (const message of turnMessages) {
    if (!isToolResultMessage(message)) continue;
    if (!IMAGE_TOOL_NAMES.has(message.toolName)) continue;
    if (message.isError === true) continue;
    const result = resolveImageResultFromDetails(message.details)
      ?? parseImageGenerationResult(extractToolResultText(message.content));
    if (!result || result.provider !== 'fal' || result.images.length === 0) {
      continue;
    }
    summaries.push({
      toolName: message.toolName,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
      imageCount: result.images.length,
    });
  }
  return summaries;
}

export function summarizePendingPaidImageDeliverables(
  deliverables: readonly PendingPaidDeliverable[],
): ChargedImageDeliverableSummary[] {
  const summaries: ChargedImageDeliverableSummary[] = [];
  const seen = new Set<string>();
  for (const deliverable of deliverables) {
    const imageResult = imageResultFromPendingDeliverable(deliverable);
    if (!imageResult || imageResult.result.provider !== 'fal') continue;
    const summary: ChargedImageDeliverableSummary = {
      toolName: imageResult.message.toolName,
      ...(imageResult.message.toolCallId ? { toolCallId: imageResult.message.toolCallId } : {}),
      ...(imageResult.result.requestId ? { requestId: imageResult.result.requestId } : {}),
      imageCount: imageResult.result.images.length,
    };
    const key = summary.requestId ?? summary.toolCallId ?? `${summary.toolName}:${summary.imageCount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(summary);
  }
  return summaries;
}

export function mergeChargedImageDeliverableSummaries(
  primary: readonly ChargedImageDeliverableSummary[],
  fallback: readonly ChargedImageDeliverableSummary[],
): ChargedImageDeliverableSummary[] {
  const merged: ChargedImageDeliverableSummary[] = [];
  const seen = new Set<string>();
  for (const summary of [...primary, ...fallback]) {
    const key = summary.requestId ?? summary.toolCallId ?? `${summary.toolName}:${summary.imageCount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...summary });
  }
  return merged;
}

export async function collectGeneratedImageAttachments(params: {
  turnMessages: AgentMessage[];
  /** Authenticated companion Personal Workspace, never companion runtime data. */
  personalFilesDir: string;
  fetchImpl?: typeof fetch;
  galleryContext?: GeneratedImageGalleryContext;
  paidDeliverables?: readonly PendingPaidDeliverable[];
}): Promise<Attachment[]> {
  const imageResults: CollectedImageGenerationResult[] = [];
  const seenImageResults = new Set<string>();
  for (const message of params.turnMessages
    .filter((message): message is AgentMessage & {
      role: 'toolResult';
      toolName: string;
      toolCallId?: string;
      details?: unknown;
      isError?: boolean;
      content: unknown;
    } => isToolResultMessage(message))
    .filter((message) => IMAGE_TOOL_NAMES.has(message.toolName))
    .filter((message) => message.isError !== true)) {
    const result = resolveImageResultFromDetails(message.details)
      ?? parseImageGenerationResult(extractToolResultText(message.content));
    collectImageResultUnique(
      imageResults,
      seenImageResults,
      result ? { message, result } : null,
    );
  }

  for (const deliverable of params.paidDeliverables ?? []) {
    collectImageResultUnique(
      imageResults,
      seenImageResults,
      imageResultFromPendingDeliverable(deliverable),
    );
  }

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
    storageDir = join(resolvePersonalImagesDir(params.personalFilesDir), dateDir);
    await mkdir(storageDir, { recursive: true });
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const personalImagesRoot = resolvePersonalImagesDir(params.personalFilesDir);
  const attachments: Attachment[] = [];
  for (const { message, result } of imageResults) {
    for (const [index, asset] of result.images.entries()) {
      let verifiedAsset = asset;
      if (asset.localPath?.trim()) {
        let canonicalRoot: string;
        let canonicalAsset: string;
        try {
          [canonicalRoot, canonicalAsset] = await Promise.all([
            realpath(personalImagesRoot),
            realpath(asset.localPath.trim()),
          ]);
        } catch (error) {
          throw new Error(`Generated image localPath must be an existing Personal Workspace image: ${String(error)}`);
        }
        if (!isStrictSubpath(canonicalAsset, canonicalRoot)) {
          throw new Error('Generated image localPath escapes the authenticated companion Personal Workspace image root');
        }
        // Never pass a mutable symlink alias to downstream channel delivery or
        // metadata writers after validating its target.
        verifiedAsset = { ...asset, localPath: canonicalAsset };
      }
      const attachment = await persistImageAsset({
        asset: verifiedAsset,
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
            asset: verifiedAsset,
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
