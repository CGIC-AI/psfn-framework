import type { ImageContent, UserMessage } from '@mariozechner/pi-ai';
import type { Attachment, SubstrateMessage } from '../../types.js';
import type { LLMProvider } from '../contracts.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import type { ImageVisionReviewer } from '../../images/types.js';
import type { CurrentTurnVisionReviewContext } from '../../images/request-context.js';
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

interface VisionAttachmentResolutionFailure {
  code:
    | 'unsupported_protocol'
    | 'invalid_url'
    | 'fetch_unavailable'
    | 'fetch_failed'
    | 'unsupported_mime'
    | 'invalid_size';
  url: string;
  detail: string;
}

type VisionAttachmentResolutionResult =
  | { block: ImageContent; failure?: never }
  | { block?: never; failure: VisionAttachmentResolutionFailure };

interface ResolvedVisionAttachmentSet {
  blocks: ImageContent[];
  failures: VisionAttachmentResolutionFailure[];
}

export interface TurnUserContentBuildResult {
  content: UserMessage['content'];
  currentTurnVisionReview?: CurrentTurnVisionReviewContext;
}

const VISION_ATTACHMENT_MAX_COUNT = 4;
const VISION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
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

export function collectVisionAttachmentUrls(message?: SubstrateMessage): string[] {
  if (!message?.attachments || message.attachments.length === 0) return [];
  return message.attachments
    .filter((attachment) => resolveAttachmentImageContentType(attachment) !== null)
    .slice(0, VISION_ATTACHMENT_MAX_COUNT)
    .map((attachment) => attachment.url.trim())
    .filter((url) => url.length > 0);
}

export function collectVisionTurnImageUrls(message?: SubstrateMessage): string[] {
  if (!message) return [];
  const attachmentUrls = collectVisionAttachmentUrls(message);
  const textUrls = collectVisionTextImageUrls(message.content, attachmentUrls);
  return dedupeVisionUrls([...attachmentUrls, ...textUrls]);
}

export function hasVisionTurnInputs(message?: SubstrateMessage): boolean {
  return collectVisionTurnImageUrls(message).length > 0;
}

export async function buildTurnUserContent(input: {
  message: SubstrateMessage;
  llmClient: LLMProvider;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
  visionReviewer?: ImageVisionReviewer | null;
}): Promise<TurnUserContentBuildResult> {
  const visionUrls = collectVisionTurnImageUrls(input.message);
  const semanticText = extractSemanticVisionTurnText(
    input.message.content,
    visionUrls,
  );
  if (visionUrls.length > 0 && input.visionReviewer) {
    try {
      const review = await input.visionReviewer.analyze({
        imageUrls: visionUrls,
        question: DEDICATED_VISION_REVIEW_QUESTION,
      });
      return {
        content: buildReviewedVisionTurnText({
          summary: review.summary,
          semanticText,
        }),
        currentTurnVisionReview: {
          imageUrls: [...visionUrls],
          question: review.question,
          summary: review.summary,
        },
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      input.logger.warn('Dedicated current-turn image review failed', {
        channelId: input.message.channelId,
        channelType: input.message.channelType,
        imageUrls: visionUrls,
        error: errorMessage,
      });
      return {
        content: buildVisionReviewFailureText({
          semanticText,
          errorMessage,
        }),
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
}): Promise<ResolvedVisionAttachmentSet> {
  const attachments = input.message.attachments ?? [];
  if (attachments.length === 0) {
    return {
      blocks: [],
      failures: [],
    };
  }

  const imageAttachments = attachments
    .map((attachment) => ({
      attachment,
      contentType: resolveAttachmentImageContentType(attachment),
    }))
    .filter((entry): entry is { attachment: Attachment; contentType: string } => entry.contentType !== null)
    .slice(0, VISION_ATTACHMENT_MAX_COUNT);
  if (imageAttachments.length === 0) {
    return {
      blocks: [],
      failures: [],
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
  };
}

async function resolveVisionAttachmentContent(input: {
  message: SubstrateMessage;
  attachment: Attachment;
  llmClient: LLMProvider;
  runtimeMode: RuntimeMode;
  logger: VisionLogger;
}): Promise<VisionAttachmentResolutionResult> {
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
      const errorMessage = toErrorMessage(error);
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
}): string {
  const textParts = [
    DEDICATED_VISION_REVIEW_INSTRUCTION,
    `Current image review: ${input.summary.trim()}`,
  ];
  if (input.semanticText.length > 0) {
    textParts.push(`User text: ${input.semanticText}`);
  }
  return textParts.join('\n\n');
}

function buildVisionReviewFailureText(input: {
  semanticText: string;
  errorMessage: string;
}): string {
  const textParts = [
    DEDICATED_VISION_REVIEW_FAILURE_INSTRUCTION,
    `Vision pipeline status: ${input.errorMessage}`,
  ];
  if (input.semanticText.length > 0) {
    textParts.push(`User text: ${input.semanticText}`);
  }
  return textParts.join('\n\n');
}

function collectVisionTextImageUrls(content: string, attachmentUrls: readonly string[]): string[] {
  const normalizedAttachmentUrls = new Set(
    attachmentUrls
      .map(normalizeAttachmentUrlForTurnComparison)
      .filter((url): url is string => url !== null),
  );
  const extractedUrls = extractHttpUrls(content);
  const imageUrls = extractedUrls.filter((url) => {
    const normalizedUrl = normalizeAttachmentUrlForTurnComparison(url);
    if (normalizedUrl !== null && normalizedAttachmentUrls.has(normalizedUrl)) {
      return true;
    }
    return inferImageMimeTypeFromAttachmentCandidate(url) !== null;
  });
  return dedupeVisionUrls(imageUrls);
}

function extractHttpUrls(content: string): string[] {
  return (content.match(HTTP_URL_PATTERN) ?? [])
    .map((value) => value.replace(/[),.!?]+$/u, '').trim())
    .filter((value) => value.length > 0);
}

function dedupeVisionUrls(urls: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed) continue;
    const normalized = normalizeAttachmentUrlForTurnComparison(trimmed) ?? trimmed;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(trimmed);
  }
  return deduped;
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
