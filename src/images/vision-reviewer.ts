import {
  completeSimple,
  type Context as PiContext,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import { resolveModel } from '../agent/stream-adapter.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMBaseUrl,
} from '../config/providers-config.js';
import { resolveProviderApiKey } from '../custody/credential-vault.js';
import { createComponentLogger } from '../logger.js';
import type { SubstrateConfig } from '../types.js';
import { extractTextContent } from '../llm/conversion.js';
import { toErrorMessage } from '../utils/errors.js';
import type {
  ImageMode,
  ImageVisionReview,
  ImageVisionReviewRequest,
  ImageVisionReviewer,
} from './types.js';

const log = createComponentLogger('ImageVisionReviewer');
const VISION_IMAGE_MAX_COUNT = 4;
const VISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

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
  fetchImpl?: typeof fetch;
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

function isDirectFetchFallbackAllowed(url: URL, comfyUiBaseUrl: string | undefined): boolean {
  const baseUrl = comfyUiBaseUrl?.trim();
  if (!baseUrl) return false;

  try {
    const comfyUrl = new URL(baseUrl);
    return comfyUrl.hostname.trim().toLowerCase() === url.hostname.trim().toLowerCase();
  } catch {
    return false;
  }
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

async function fetchImageContentDirect(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ImageContent> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'image/*',
    },
  });
  if (!response.ok) {
    throw new Error(`direct image fetch failed with ${String(response.status)}`);
  }

  const mimeType = response.headers.get('content-type')
    ?.split(';')[0]
    .trim()
    .toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`direct image fetch returned unsupported content type "${mimeType || 'unknown'}"`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > VISION_IMAGE_MAX_BYTES) {
    throw new Error(`direct image fetch returned invalid image size ${String(bytes.length)}`);
  }

  return {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType,
  };
}

export class DefaultImageVisionReviewer implements ImageVisionReviewer {
  private readonly fetchImpl: typeof fetch;
  private readonly completeImpl: ImageVisionReviewerOptions['completeImpl'];

  constructor(
    private readonly config: SubstrateConfig,
    private readonly options: ImageVisionReviewerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.completeImpl = options.completeImpl ?? completeSimple;
  }

  async analyze(input: ImageVisionReviewRequest): Promise<ImageVisionReview> {
    const imageUrls = input.imageUrls
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, VISION_IMAGE_MAX_COUNT);
    if (imageUrls.length === 0) {
      throw new Error('image_analyze requires at least one image URL');
    }

    const model = resolveModel(this.config, 'vision');
    const question = normalizeQuestion(input);
    const imageBlocks = await Promise.all(imageUrls.map((url) => this.resolveImageContent(url)));
    const response = await this.completeImpl(
      model,
      {
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
      } satisfies PiContext,
      {
        apiKey: resolveApiKey(model, this.config),
        maxTokens: model.maxTokens,
      },
    );

    const summary = extractTextContent(response.content).trim();
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
    if (binaryFetcher) {
      try {
        return validateFetchedImage(await binaryFetcher(url, {
          lane: 'default',
          maxBytes: VISION_IMAGE_MAX_BYTES,
        }));
      } catch (error) {
        if (!isDirectFetchFallbackAllowed(parsedUrl, this.config.comfyUiBaseUrl)) {
          throw new Error(`vision fetch failed for ${url}: ${toErrorMessage(error)}`);
        }

        log.debug('Falling back to direct fetch for image vision review', {
          url,
          error: toErrorMessage(error),
        });
      }
    }

    return await fetchImageContentDirect(this.fetchImpl, url);
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
