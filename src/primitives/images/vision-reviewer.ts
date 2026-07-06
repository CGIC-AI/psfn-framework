import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  completeSimple,
  type Context as PiContext,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { resolveModel } from '../../core/agent/stream-adapter.js';
import { getRequestContext } from '../llm/request-context.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMBaseUrl,
} from '../../system/config/providers-config.js';
import { resolveProviderApiKey } from '../../boundary/custody/credential-vault.js';
import { sanitizeCoreSubstrateConfig, type SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { extractTextContent } from '../llm/conversion.js';
import { clampVisionCompletionMaxTokens } from '../llm/vision-limits.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { CorrelationMetadata, LLMContext } from '../../shared/contracts/runtime.js';
import type {
  ImageMode,
  ImageVisionReview,
  ImageVisionReviewRequest,
  ImageVisionReviewer,
} from './types.js';

const VISION_IMAGE_MAX_COUNT = 4;
const VISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const log = createComponentLogger('ImageVisionReviewer');

type BinaryFetcher = (
  url: string,
  options?: {
    lane?: 'default' | 'local_crawler';
    maxBytes?: number;
    headers?: Record<string, string>;
  },
) => Promise<{
  dataBase64: string;
  mimeType: string;
  sizeBytes: number;
}>;

export interface ImageVisionReviewerOptions {
  binaryFetcher?: BinaryFetcher;
  llmProvider?: LLMProviderPort;
  completeImpl?: (
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ) => Promise<{
    model?: string;
    content?: unknown[];
  }>;
}

function normalizeQuestion(input: ImageVisionReviewRequest): string {
  const explicit = input.question?.trim();
  if (explicit) return explicit;

  const promptLine = input.prompt?.trim()
    ? `Original image prompt: ${input.prompt.trim()}`
    : 'No original image prompt was provided.';
  const modeLine = input.mode === 'edit'
    ? 'Describe the edited image, check whether the appearance stays consistent, and call out any visible issues.'
    : 'Describe the generated image, check whether the appearance stays consistent, and call out any visible issues.';

  return `${modeLine}\n${promptLine}`;
}

function resolveApiKey(model: Model<any>, config: SubstrateConfig): string | undefined {
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(config);
  if (litellmBaseUrl) {
    return resolveConfiguredLiteLLMApiKey(config);
  }

  const modelProvider = (model as { provider?: unknown }).provider;
  if (typeof modelProvider === 'string' && modelProvider.trim().length > 0) {
    return resolveProviderApiKey(modelProvider, config);
  }

  return resolveProviderApiKey(config.primaryProvider, config);
}

function validateFetchedImage(payload: {
  dataBase64: string;
  mimeType: string;
  sizeBytes: number;
}): ImageContent {
  const mimeType = payload.mimeType
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new Error(`vision review fetch returned unsupported content type "${mimeType}"`);
  }
  if (payload.sizeBytes <= 0 || payload.sizeBytes > VISION_IMAGE_MAX_BYTES) {
    throw new Error(`vision review fetch returned invalid image size ${String(payload.sizeBytes)}`);
  }

  return {
    type: 'image',
    data: payload.dataBase64,
    mimeType,
  };
}

function inferMimeTypeFromLocalPath(localPath: string): string {
  const extension = extname(localPath).trim().toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'image/png';
  }
}

function resolveConfiguredComfyOrigin(config: SubstrateConfig): string | null {
  const baseUrl = config.comfyUiBaseUrl?.trim();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function extractVisionResponseSummary(response: { content?: unknown[] | string }): string {
  return typeof response.content === 'string'
    ? response.content.trim()
    : extractTextContent(response.content).trim();
}

function buildVisionReviewCorrelation(): CorrelationMetadata {
  const requestContext = getRequestContext();
  return {
    ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
    ...(requestContext?.channelId ? { channelId: requestContext.channelId } : {}),
    requestId: requestContext?.requestId
      ? `${requestContext.requestId}:vision-review`
      : `vision-review-${Date.now()}`,
    callType: 'tool',
    ...(requestContext?.toolName ? { toolName: requestContext.toolName } : {}),
    purpose: 'images.vision_review',
    originType: 'tool',
    originStage: 'images.vision_review',
    ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
  };
}

export class DefaultImageVisionReviewer implements ImageVisionReviewer {
  private readonly completeImpl: NonNullable<ImageVisionReviewerOptions['completeImpl']>;

  constructor(
    private readonly config: SubstrateConfig,
    private readonly options: ImageVisionReviewerOptions = {},
  ) {
    this.completeImpl = options.completeImpl ?? completeSimple;
  }

  async analyze(input: ImageVisionReviewRequest): Promise<ImageVisionReview> {
    const imageUrls = input.imageUrls
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, VISION_IMAGE_MAX_COUNT);
    if (imageUrls.length === 0) {
      throw new Error('media action="analyze" requires at least one image URL');
    }

    const question = normalizeQuestion(input);
    const imageLocalPaths = (input.imageLocalPaths ?? [])
      .map((value) => value.trim())
      .slice(0, imageUrls.length);
    const imageBlocks = await Promise.all(imageUrls.map((url, index) => {
      const localPath = imageLocalPaths[index];
      if (localPath) {
        return this.resolveLocalImageContent(localPath);
      }
      return this.resolveImageContent(url);
    }));
    const context = {
      systemPrompt: [
        'You are the companion\'s vision review path.',
        'Inspect the attached image content directly.',
        'Answer concretely, keep it concise, and do not tell the user to check the image for you.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          ...imageBlocks,
        ],
        timestamp: Date.now(),
      }],
    };

    if (this.options.llmProvider) {
      // The LLM client owns 'vision'-purpose candidate resolution, fallback
      // iteration, per-candidate retries, and circuit-breaker cooldowns; the
      // reviewer only supplies the context and correlation metadata.
      const correlation = buildVisionReviewCorrelation();
      try {
        const response = await this.options.llmProvider.complete(
          {
            systemPrompt: context.systemPrompt,
            messages: context.messages as unknown as LLMContext['messages'],
            correlation,
          },
          'vision',
        );
        const summary = extractVisionResponseSummary(response);
        if (!summary) {
          throw new Error(`vision review returned empty text from ${response.model}`);
        }
        return {
          question,
          summary,
          model: response.model,
          imageCount: imageBlocks.length,
        };
      } catch (error) {
        log.warn('Vision review completion failed', {
          imageCount: imageBlocks.length,
          error: toErrorMessage(error),
          ...correlation,
        });
        throw error;
      }
    }

    const model = resolveModel(sanitizeCoreSubstrateConfig(this.config), 'vision');
    const response = await this.completeImpl(
      model,
      context as unknown as PiContext,
      {
        apiKey: resolveApiKey(model, this.config),
        maxTokens: clampVisionCompletionMaxTokens(model.maxTokens),
      },
    );
    const summary = extractVisionResponseSummary(response);
    if (!summary) {
      throw new Error('vision review returned empty text');
    }
    return {
      question,
      summary,
      model: response.model ?? String(model.id),
      imageCount: imageBlocks.length,
    };
  }

  private async resolveImageContent(url: string): Promise<ImageContent> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`invalid image URL "${url}"`);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`unsupported image URL protocol "${parsedUrl.protocol}"`);
    }

    const binaryFetcher = this.options.binaryFetcher;
    if (!binaryFetcher) {
      throw new Error(`vision review requires gateway binary fetch for ${url}`);
    }

    try {
      const lane = parsedUrl.origin === resolveConfiguredComfyOrigin(this.config)
        ? 'local_crawler'
        : 'default';
      return validateFetchedImage(await binaryFetcher(url, {
        lane,
        maxBytes: VISION_IMAGE_MAX_BYTES,
      }));
    } catch (error) {
      throw new Error(`vision fetch failed for ${url}: ${toErrorMessage(error)}`);
    }
  }

  private async resolveLocalImageContent(localPath: string): Promise<ImageContent> {
    try {
      const bytes = await readFile(localPath);
      return validateFetchedImage({
        dataBase64: bytes.toString('base64'),
        mimeType: inferMimeTypeFromLocalPath(localPath),
        sizeBytes: bytes.byteLength,
      });
    } catch (error) {
      throw new Error(`vision local file read failed for ${localPath}: ${toErrorMessage(error)}`);
    }
  }
}

export function createDefaultImageReviewQuestion(input: {
  mode: ImageMode;
  prompt: string;
}): string {
  return normalizeQuestion({
    mode: input.mode,
    prompt: input.prompt,
    imageUrls: [],
  });
}
