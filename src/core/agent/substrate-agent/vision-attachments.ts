import type { ImageContent, UserMessage } from '@mariozechner/pi-ai';
import type { Attachment, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../contracts.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import type { CurrentTurnVisionReviewContext } from '../../../primitives/images/request-context.js';
import { inferImageMimeTypeFromAttachmentCandidate } from '../substrate-agent-helpers.js';
import { sanitizeDiagnosticText } from '../../../shared/diagnostics/redaction.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

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

interface VisionAttachmentResolutionFailure {
  code:
    | 'unsupported_protocol'
    | 'invalid_url'
    | 'fetch_unavailable'
    | 'fetch_failed'
    | 'unsupported_mime'
    | 'invalid_size'
    | 'invalid_data';
  url: string;
  detail: string;
}

type VisionAttachmentResolutionResult =
  | { block: ImageContent; failure?: never }
  | { block?: never; failure: VisionAttachmentResolutionFailure };

interface ResolvedVisionAttachmentSet {
  blocks: ImageContent[];
  failures: VisionAttachmentResolutionFailure[];
  /** Image attachments beyond the embed cap, dropped and reported. */
  overflowCount: number;
}

export interface TurnUserContentBuildResult {
  content: UserMessage['content'];
  currentTurnVisionReview?: CurrentTurnVisionReviewContext;
  persistedUserContent?: string;
}

/** Max images per single vision-model call. */
const VISION_ATTACHMENT_MAX_COUNT = 4;
/**
 * Per-turn ceiling across chunked concurrent vision calls (3 calls of 4).
 * Anything beyond this is dropped LOUDLY — the turn text says how many were
 * not reviewed; nothing is silently truncated.
 */
const VISION_TURN_IMAGE_CEILING = 12;
const VISION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const DEDICATED_VISION_REVIEW_MAX_ATTEMPTS = 3;
const LIVE_ATTACHMENT_DIRECT_INSPECTION_INSTRUCTION = [
  '[Runtime note]',
  'The current user turn includes live image attachment bytes below.',
  'Inspect the current image attachment(s) directly and ground your reply in what is actually visible there.',
  'If prior session history, memory, or earlier replies describe a different image, treat that as stale and ignore it for this turn.',
  'Do not infer image contents from prior conversation, stale URLs, pasted CDN links, or earlier failed image attempts.',
  'Do not call media action="analyze" for the current attachment unless the user explicitly asks you to inspect a different URL.',
].join(' ');
const UNRESOLVED_ATTACHMENT_VISIBILITY_INSTRUCTION = [
  '[Runtime note]',
  'The current user turn included image attachment(s), but the runtime could not load their image bytes for this turn.',
  'You cannot see the current image contents.',
  'Do not pretend you saw them.',
  'If needed, say that you could not access the current image and ask the user to resend it.',
].join(' ');
const TRANSPORT_METADATA_ONLY_INSTRUCTION = [
  'The visible text placeholder or CDN URL is transport metadata, not the semantic request.',
  'Respond to the current image itself first.',
].join(' ');
const PARTIAL_ATTACHMENT_RESOLUTION_INSTRUCTION = [
  'Some current-turn image attachments failed to load.',
  'Only rely on the image attachment(s) that are actually present below.',
].join(' ');
const DEDICATED_VISION_REVIEW_INSTRUCTION = [
  '[Runtime note]',
  'The current user turn included image input that has already been inspected by the dedicated vision pipeline.',
  'Ground your response in the image review below.',
  'If prior session history, memory, or earlier replies describe a different image, treat that as stale and ignore it for this turn.',
  'Do not pretend you saw anything other than what the review below describes.',
].join(' ');
const DEDICATED_VISION_REVIEW_FAILURE_INSTRUCTION = [
  '[Runtime note]',
  'The current user turn included image input, but the dedicated vision pipeline failed for this turn.',
  'You cannot reliably see the current image.',
  'Do not pretend you saw it.',
  'If needed, say that the image inspection failed and ask the user to resend it.',
].join(' ');
const DEDICATED_VISION_REVIEW_QUESTION = [
  'Describe exactly what is visible in the current image input.',
  'Be concrete and concise.',
  'Ignore prior conversation or earlier image descriptions.',
].join(' ');
const HTTP_URL_PATTERN = /https?:\/\/\S+/gi;

export function hasVisionAttachments(message?: SubstrateMessage): boolean {
  if (!message?.attachments || message.attachments.length === 0) return false;
  return message.attachments.some((attachment) => resolveAttachmentImageContentType(attachment) !== null);
}

interface VisionAttachmentUrlCollection {
  urls: string[];
  /** Image attachments beyond the per-turn ceiling, dropped and reported. */
  droppedCount: number;
}

function collectVisionAttachmentUrlsDetailed(message?: SubstrateMessage): VisionAttachmentUrlCollection {
  if (!message?.attachments || message.attachments.length === 0) {
    return { urls: [], droppedCount: 0 };
  }
  const fetchable = message.attachments
    .filter((attachment) => resolveAttachmentImageContentType(attachment) !== null)
    .filter((attachment) => isFetchableAttachmentUrl(attachment.url))
    .map((attachment) => attachment.url.trim())
    .filter((url) => url.length > 0);
  return {
    urls: fetchable.slice(0, VISION_TURN_IMAGE_CEILING),
    droppedCount: Math.max(0, fetchable.length - VISION_TURN_IMAGE_CEILING),
  };
}

export function collectVisionAttachmentUrls(message?: SubstrateMessage): string[] {
  return collectVisionAttachmentUrlsDetailed(message).urls;
}

export function collectVisionTurnImageUrls(message?: SubstrateMessage): string[] {
  if (!message) return [];
  if (!message.attachments || message.attachments.length === 0) return [];
  return message.attachments
    .filter((attachment) => resolveAttachmentImageContentType(attachment) !== null)
    .slice(0, VISION_TURN_IMAGE_CEILING)
    .map((attachment) => attachment.url.trim())
    .filter((url) => url.length > 0);
}

export function hasVisionTurnInputs(message?: SubstrateMessage): boolean {
  return hasVisionAttachments(message);
}

export function buildPersistedVisionUnavailableUserContent(message: SubstrateMessage): string {
  return appendPersistedImageAttachmentBlock(message.content, buildPersistedImageAttachmentBlock({
    imageCount: countVisionTurnImageInputs(message),
    unavailableReason: 'vision pipeline failed before image contents could be inspected.',
  }));
}

export async function buildTurnUserContent(input: {
  message: SubstrateMessage;
  llmClient: LLMProviderPort;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
  visionReviewer?: ImageVisionReviewer | null;
}): Promise<TurnUserContentBuildResult> {
  const visionCollection = collectVisionAttachmentUrlsDetailed(input.message);
  const visionUrls = visionCollection.urls;
  const visionReferences = collectVisionTurnImageUrls(input.message);
  const hasInlineImages = hasInlineVisionAttachments(input.message);
  const semanticText = extractSemanticVisionTurnText(
    input.message.content,
    visionReferences,
  );
  if (visionUrls.length > 0 && !hasInlineImages && input.visionReviewer) {
    try {
      const review = await analyzeVisionUrlsInChunks({
        reviewer: input.visionReviewer,
        imageUrls: visionUrls,
        question: DEDICATED_VISION_REVIEW_QUESTION,
        logger: input.logger,
        channelId: input.message.channelId,
        channelType: input.message.channelType,
      });
      const extraNotes = [...review.failureNotes];
      if (visionCollection.droppedCount > 0) {
        extraNotes.push(
          `${String(visionCollection.droppedCount)} additional image attachment(s) exceeded the ${String(VISION_TURN_IMAGE_CEILING)}-image per-turn limit and were not reviewed; say so if it matters.`,
        );
      }
      return {
        content: buildReviewedVisionTurnText({
          summary: review.summary,
          semanticText,
          extraNotes,
        }),
        persistedUserContent: appendPersistedImageAttachmentBlock(
          input.message.content,
          buildPersistedImageAttachmentBlock({
            summary: review.summary,
            model: review.model,
            imageCount: review.imageCount,
          }),
        ),
        currentTurnVisionReview: {
          imageUrls: [...review.reviewedUrls],
          question: review.question,
          summary: review.summary,
        },
      };
    } catch (error) {
      const errorMessage = sanitizeDiagnosticText(toErrorMessage(error));
      input.logger.warn('Dedicated current-turn image review failed', {
        channelId: input.message.channelId,
        channelType: input.message.channelType,
        imageUrls: visionUrls,
        error: errorMessage,
      });
      return {
        content: buildVisionReviewFailureText({
          semanticText,
        }),
        persistedUserContent: buildPersistedVisionUnavailableUserContent(input.message),
      };
    }
  }

  const resolved = await resolveVisionImageContentBlocks(input);
  const hasSemanticText = semanticText.length > 0;
  const hasTransportMetadataOnlyText = input.message.content.trim().length > 0 && !hasSemanticText;

  if (resolved.blocks.length === 0) {
    if (resolved.failures.length === 0) {
      return { content: input.message.content };
    }
    return {
      content: buildUnresolvedVisionTurnText({
        semanticText,
        failures: resolved.failures,
      }),
    };
  }

  const noteParts = [LIVE_ATTACHMENT_DIRECT_INSPECTION_INSTRUCTION];
  if (hasTransportMetadataOnlyText) {
    noteParts.push(TRANSPORT_METADATA_ONLY_INSTRUCTION);
  }
  if (resolved.failures.length > 0) {
    noteParts.push(PARTIAL_ATTACHMENT_RESOLUTION_INSTRUCTION);
    noteParts.push(formatVisionAttachmentFailureSummary(resolved.failures));
  }
  if (resolved.overflowCount > 0) {
    noteParts.push(
      `${String(resolved.overflowCount)} additional image attachment(s) beyond the first ${String(VISION_ATTACHMENT_MAX_COUNT)} were not embedded for this turn; say so if it matters.`,
    );
  }

  const textParts = [noteParts.join(' ')];
  if (hasSemanticText) {
    textParts.push(`User text: ${semanticText}`);
  }

  return {
    content: [
      { type: 'text', text: textParts.join('\n\n') },
      ...resolved.blocks,
    ],
  };
}

function chunkVisionUrls(urls: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    chunks.push(urls.slice(index, index + size));
  }
  return chunks;
}

interface ChunkedVisionReviewResult {
  summary: string;
  question: string;
  reviewedUrls: string[];
  imageCount: number;
  model?: string;
  /** Explicit notes for chunks whose review failed — never silently dropped. */
  failureNotes: string[];
}

/**
 * More images than one vision call accepts fan out as CONCURRENT calls (one
 * per chunk of VISION_ATTACHMENT_MAX_COUNT) and the summaries merge with
 * image-range labels. Vision review is a negligible-charge action, so
 * parallel fan-out is the right default; charged generative work must never
 * auto-parallelize like this.
 */
async function analyzeVisionUrlsInChunks(input: {
  reviewer: ImageVisionReviewer;
  imageUrls: string[];
  question: string;
  logger: VisionLogger;
  channelId: string;
  channelType?: string;
}): Promise<ChunkedVisionReviewResult> {
  const chunks = chunkVisionUrls(input.imageUrls, VISION_ATTACHMENT_MAX_COUNT);
  const settled = await Promise.allSettled(chunks.map((chunk) => analyzeWithDedicatedVisionRetry({
    ...input,
    imageUrls: chunk,
  })));

  const summaries: string[] = [];
  const reviewedUrls: string[] = [];
  const failureNotes: string[] = [];
  let reviewedImageCount = 0;
  let model: string | undefined;
  settled.forEach((result, index) => {
    const chunk = chunks[index];
    const start = index * VISION_ATTACHMENT_MAX_COUNT + 1;
    const end = start + chunk.length - 1;
    const rangeLabel = chunks.length === 1
      ? null
      : (chunk.length === 1 ? `Image ${String(start)}` : `Images ${String(start)}-${String(end)}`);
    if (result.status === 'fulfilled') {
      summaries.push(rangeLabel ? `${rangeLabel}: ${result.value.summary}` : result.value.summary);
      reviewedUrls.push(...chunk);
      reviewedImageCount += Number.isFinite(result.value.imageCount)
        ? result.value.imageCount
        : chunk.length;
      if (!model && typeof result.value.model === 'string' && result.value.model.trim().length > 0) {
        model = result.value.model.trim();
      }
      return;
    }
    failureNotes.push(
      `Vision review failed for ${rangeLabel ?? 'the attached image(s)'}: ${toErrorMessage(result.reason)}. Do not pretend you saw those.`,
    );
  });

  if (summaries.length === 0) {
    const firstRejection = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const reason: unknown = firstRejection?.reason;
    throw reason instanceof Error ? reason : new Error(toErrorMessage(reason));
  }

  const firstFulfilled = settled.find(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<ImageVisionReviewer['analyze']>>> =>
      result.status === 'fulfilled',
  );
  return {
    summary: summaries.join('\n'),
    question: firstFulfilled?.value.question ?? input.question,
    reviewedUrls,
    imageCount: reviewedImageCount || reviewedUrls.length,
    ...(model ? { model } : {}),
    failureNotes,
  };
}

function countVisionTurnImageInputs(message?: SubstrateMessage): number {
  return message?.attachments
    ?.filter((attachment) => resolveAttachmentImageContentType(attachment) !== null)
    .length ?? 0;
}

function appendPersistedImageAttachmentBlock(content: string, block: string): string {
  const trimmedContent = content.trimEnd();
  if (trimmedContent.length === 0) {
    return block;
  }
  return `${trimmedContent}\n\n${block}`;
}

function buildPersistedImageAttachmentBlock(input: {
  imageCount: number;
  summary?: string;
  model?: string;
  unavailableReason?: string;
}): string {
  const lines = [
    '---',
    'Image attachment:',
  ];
  const summary = input.summary?.trim();
  if (summary && summary.length > 0) {
    lines.push(`Description: ${summary}`);
  } else {
    lines.push(`Description unavailable: ${input.unavailableReason ?? 'vision pipeline did not return a description.'}`);
  }
  const model = input.model?.trim();
  if (model && model.length > 0) {
    lines.push(`Model: ${model}`);
  }
  lines.push(`Image count: ${String(Math.max(1, input.imageCount))}`);
  lines.push('---');
  return lines.join('\n');
}

async function analyzeWithDedicatedVisionRetry(input: {
  reviewer: ImageVisionReviewer;
  imageUrls: string[];
  question: string;
  logger: VisionLogger;
  channelId: string;
  channelType?: string;
}): Promise<Awaited<ReturnType<ImageVisionReviewer['analyze']>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DEDICATED_VISION_REVIEW_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await input.reviewer.analyze({
        imageUrls: input.imageUrls,
        question: input.question,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= DEDICATED_VISION_REVIEW_MAX_ATTEMPTS) {
        break;
      }
      input.logger.warn('Dedicated current-turn image review attempt failed; retrying', {
        channelId: input.channelId,
        channelType: input.channelType,
        imageUrls: input.imageUrls,
        attempt,
        maxAttempts: DEDICATED_VISION_REVIEW_MAX_ATTEMPTS,
        error: sanitizeDiagnosticText(toErrorMessage(error)),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError));
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

function hasInlineVisionAttachments(message: SubstrateMessage): boolean {
  return Boolean(message.attachments?.some((attachment) => {
    return typeof attachment.dataBase64 === 'string'
      && attachment.dataBase64.trim().length > 0
      && resolveAttachmentImageContentType(attachment) !== null;
  }));
}

function isFetchableAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveVisionImageContentBlocks(input: {
  message: SubstrateMessage;
  llmClient: LLMProviderPort;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<ResolvedVisionAttachmentSet> {
  const attachments = input.message.attachments ?? [];
  if (attachments.length === 0) {
    return {
      blocks: [],
      failures: [],
      overflowCount: 0,
    };
  }

  const allImageAttachments = attachments
    .map((attachment) => ({
      attachment,
      contentType: resolveAttachmentImageContentType(attachment),
    }))
    .filter((entry): entry is { attachment: Attachment; contentType: string } => entry.contentType !== null);
  const imageAttachments = allImageAttachments.slice(0, VISION_ATTACHMENT_MAX_COUNT);
  const overflowCount = allImageAttachments.length - imageAttachments.length;
  if (imageAttachments.length === 0) {
    return {
      blocks: [],
      failures: [],
      overflowCount: 0,
    };
  }

  const resolved = await Promise.all(
    imageAttachments.map((entry) => resolveVisionAttachmentContent({
      message: input.message,
      attachment: entry.attachment,
      llmClient: input.llmClient,
      runtimeMode: input.runtimeMode,
      logger: input.logger,
    })),
  );
  const blocks = resolved
    .map((entry) => entry.block)
    .filter((block): block is ImageContent => block !== undefined);
  const failures = resolved
    .map((entry) => entry.failure)
    .filter((failure): failure is VisionAttachmentResolutionFailure => failure !== undefined);

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
      failureCodes: failures.map((failure) => failure.code),
      failureDetails: failures.map((failure) => failure.detail),
    });
  }

  return {
    blocks,
    failures,
    overflowCount,
  };
}

async function resolveVisionAttachmentContent(input: {
  message: SubstrateMessage;
  attachment: Attachment;
  llmClient: LLMProviderPort;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<VisionAttachmentResolutionResult> {
  const inlineDataBase64 = input.attachment.dataBase64?.trim();
  if (inlineDataBase64) {
    const contentType = resolveAttachmentImageContentType(input.attachment);
    if (!contentType) {
      return {
        failure: {
          code: 'unsupported_mime',
          url: input.attachment.url,
          detail: 'Inline image attachment did not include a supported image content type.',
        },
      };
    }
    return resolveInlineVisionAttachmentContent({
      url: input.attachment.url,
      dataBase64: inlineDataBase64,
      contentType,
    });
  }

  let attachmentUrl: URL;
  try {
    attachmentUrl = new URL(input.attachment.url);
  } catch {
    return {
      failure: {
        code: 'invalid_url',
        url: input.attachment.url,
        detail: 'Attachment URL is invalid.',
      },
    };
  }
  if (attachmentUrl.protocol !== 'https:') {
    return {
      failure: {
        code: 'unsupported_protocol',
        url: attachmentUrl.toString(),
        detail: `Attachment URL protocol "${attachmentUrl.protocol}" is not supported for live image fetches.`,
      },
    };
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
        return {
          failure: {
            code: 'unsupported_mime',
            url: attachmentUrl.toString(),
            detail: `Fetched attachment returned unsupported content type "${responseMimeType || 'unknown'}".`,
          },
        };
      }
      if (fetched.sizeBytes <= 0 || fetched.sizeBytes > VISION_ATTACHMENT_MAX_BYTES) {
        return {
          failure: {
            code: 'invalid_size',
            url: attachmentUrl.toString(),
            detail: `Fetched attachment size ${fetched.sizeBytes} is outside the supported range.`,
          },
        };
      }
      return {
        block: {
          type: 'image',
          data: fetched.dataBase64,
          mimeType: responseMimeType,
        },
      };
    } catch (error) {
      const errorMessage = sanitizeDiagnosticText(toErrorMessage(error));
      input.logger.warn('Gateway binary fetch for live image attachment failed', {
        channelId: input.message.channelId,
        channelType: input.message.channelType,
        url: attachmentUrl.toString(),
        error: errorMessage,
      });
      return {
        failure: {
          code: 'fetch_failed',
          url: attachmentUrl.toString(),
          detail: errorMessage,
        },
      };
    }
  }

  const capabilityUnavailableMessage = `Gateway binary fetch capability is unavailable in runtime mode "${input.runtimeMode}".`;
  input.logger.warn('Skipping live image attachment because gateway binary fetch capability is unavailable', {
    channelId: input.message.channelId,
    channelType: input.message.channelType,
    url: attachmentUrl.toString(),
    runtimeMode: input.runtimeMode,
  });
  return {
    failure: {
      code: 'fetch_unavailable',
      url: attachmentUrl.toString(),
      detail: capabilityUnavailableMessage,
    },
  };
}

function resolveInlineVisionAttachmentContent(input: {
  url: string;
  dataBase64: string;
  contentType: string;
}): VisionAttachmentResolutionResult {
  const dataBase64 = input.dataBase64.replace(/\s+/g, '');
  if (!isStrictBase64(dataBase64)) {
    return {
      failure: {
        code: 'invalid_data',
        url: input.url,
        detail: 'Inline image attachment data is not valid base64.',
      },
    };
  }

  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.byteLength <= 0 || bytes.byteLength > VISION_ATTACHMENT_MAX_BYTES) {
    return {
      failure: {
        code: 'invalid_size',
        url: input.url,
        detail: `Inline image attachment size ${bytes.byteLength} is outside the supported range.`,
      },
    };
  }

  return {
    block: {
      type: 'image',
      data: dataBase64,
      mimeType: input.contentType,
    },
  };
}

function isStrictBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function extractSemanticVisionTurnText(
  content: string,
  visionUrls: readonly string[],
): string {
  let semanticText = content.trim();
  if (!semanticText) return '';

  semanticText = semanticText
    .replace(/\(image attachments?\)/gi, ' ')
    .trim();
  if (!semanticText) return '';

  const normalizedVisionUrls = new Set(
    visionUrls
      .map(normalizeAttachmentUrlForTurnComparison)
      .filter((url): url is string => url !== null),
  );
  for (const url of extractHttpUrls(semanticText)) {
    const normalizedUrl = normalizeAttachmentUrlForTurnComparison(url);
    if (normalizedUrl !== null && normalizedVisionUrls.has(normalizedUrl)) {
      semanticText = semanticText.split(url).join(' ');
    }
  }

  semanticText = semanticText.replace(/\s+/g, ' ').trim();
  if (!semanticText) return '';
  if (isTransportPlaceholderText(semanticText)) return '';
  if (isAttachmentUrlOnlyText(semanticText, visionUrls)) return '';
  return semanticText;
}

function isTransportPlaceholderText(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return normalized === '(image attachment)' || normalized === '(image attachments)';
}

function isAttachmentUrlOnlyText(content: string, attachmentUrls: readonly string[]): boolean {
  const tokens = content
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;

  const rawAttachmentUrls = new Set(attachmentUrls.map((url) => url.trim()).filter(Boolean));
  const normalizedAttachmentUrls = new Set(
    attachmentUrls
      .map(normalizeAttachmentUrlForTurnComparison)
      .filter((url): url is string => url !== null),
  );

  return tokens.every((token) => {
    if (rawAttachmentUrls.has(token)) return true;
    const normalizedToken = normalizeAttachmentUrlForTurnComparison(token);
    return normalizedToken !== null && normalizedAttachmentUrls.has(normalizedToken);
  });
}

function normalizeAttachmentUrlForTurnComparison(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function buildUnresolvedVisionTurnText(input: {
  semanticText: string;
  failures: readonly VisionAttachmentResolutionFailure[];
}): string {
  const textParts = [UNRESOLVED_ATTACHMENT_VISIBILITY_INSTRUCTION];
  textParts.push(formatVisionAttachmentFailureSummary(input.failures));
  if (input.semanticText.length > 0) {
    textParts.push(`User text: ${input.semanticText}`);
  }
  return textParts.join('\n\n');
}

function buildReviewedVisionTurnText(input: {
  summary: string;
  semanticText: string;
  extraNotes?: readonly string[];
}): string {
  const textParts = [
    DEDICATED_VISION_REVIEW_INSTRUCTION,
    `Current image review: ${input.summary.trim()}`,
  ];
  for (const note of input.extraNotes ?? []) {
    textParts.push(`[Runtime note] ${note}`);
  }
  if (input.semanticText.length > 0) {
    textParts.push(`User text: ${input.semanticText}`);
  }
  return textParts.join('\n\n');
}

function buildVisionReviewFailureText(input: {
  semanticText: string;
}): string {
  const textParts = [
    DEDICATED_VISION_REVIEW_FAILURE_INSTRUCTION,
    'Vision pipeline status: unavailable after dedicated review attempts.',
  ];
  if (input.semanticText.length > 0) {
    textParts.push(`User text: ${input.semanticText}`);
  }
  return textParts.join('\n\n');
}

function extractHttpUrls(content: string): string[] {
  return (content.match(HTTP_URL_PATTERN) ?? [])
    .map((value) => value.replace(/[),.!?]+$/u, '').trim())
    .filter((value) => value.length > 0);
}

function formatVisionAttachmentFailureSummary(
  failures: readonly VisionAttachmentResolutionFailure[],
): string {
  const summarized = failures
    .slice(0, 2)
    .map((failure) => `${summarizeVisionAttachmentUrl(failure.url)}: ${failure.detail}`);
  if (failures.length > 2) {
    summarized.push(`${failures.length - 2} additional attachment failure(s) omitted.`);
  }
  return `Attachment status: ${summarized.join(' ')}`;
}

function summarizeVisionAttachmentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}
