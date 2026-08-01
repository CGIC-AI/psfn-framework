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
  normalizeCorrelationValue,
  resolveCorrelationMetadata,
} from '../llm/correlation.js';
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
import {
  describeEmbodimentVerdict,
  type EmbodimentConsistencyVerdict,
  type ImageEmbodimentConsistency,
  type ImageMode,
  type ImageVisionReview,
  type ImageVisionReviewRequest,
  type ImageVisionReviewer,
} from './types.js';

const VISION_IMAGE_MAX_COUNT = 4;
const VISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Minimal shape the reviewer needs to load the active identity reference.
 * `ImageReferenceStore` satisfies this structurally without a hard import.
 */
export interface VisionReviewReferenceResolver {
  resolveForTool(selector: { useDefaultReference?: boolean }): Promise<{
    id: string;
    dataUrl: string;
    description: string;
  } | null>;
}

const EMBODIMENT_VERDICTS: readonly EmbodimentConsistencyVerdict[] = [
  'same_me',
  'drifted',
  'different_person',
];

const EMBODIMENT_MARKER = /EMBODIMENT:\s*(same_me|drifted|different_person)\b\s*[—:-]?\s*(.*)$/im;

function parseDataUrlImageContent(dataUrl: string): ImageContent | null {
  const match = /^data:([^;,]+);base64,(.+)$/is.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) return null;
  return { type: 'image', data: match[2].trim(), mimeType };
}

function parseEmbodimentConsistency(
  summary: string,
  reference: { id: string; description: string },
): ImageEmbodimentConsistency | undefined {
  const match = EMBODIMENT_MARKER.exec(summary);
  if (!match) return undefined;
  const verdict = match[1].toLowerCase() as EmbodimentConsistencyVerdict;
  if (!EMBODIMENT_VERDICTS.includes(verdict)) return undefined;
  const note = match[2].trim();
  const description = reference.description.trim();
  return {
    verdict,
    framing: describeEmbodimentVerdict(verdict),
    note: note.length > 0 ? note : describeEmbodimentVerdict(verdict),
    referenceId: reference.id,
    ...(description ? { referenceDescription: description } : {}),
  };
}

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
  /** Loads the active identity reference for embodiment-consistency reviews. */
  referenceResolver?: VisionReviewReferenceResolver;
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

export class VisionEmptyResponseError extends Error {
  readonly code = 'vision_empty_response';

  constructor(model?: string) {
    super(
      `vision_empty_response: vision review returned empty text`
      + `${model ? ` from ${model}` : ''}`,
    );
    this.name = 'VisionEmptyResponseError';
  }
}

function buildVisionReviewCorrelation(): CorrelationMetadata {
  const requestContext = getRequestContext();
  const requestId = normalizeCorrelationValue(requestContext?.requestId);
  return resolveCorrelationMetadata(requestContext, {
    requestId: requestId ? `${requestId}:vision-review` : `vision-review-${Date.now()}`,
    callType: 'tool',
    purpose: 'images.vision_review',
    originStage: 'images.vision_review',
  }, 'vision');
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

    const baseQuestion = normalizeQuestion(input);
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

    const embodimentReference = input.compareToReference === true
      ? await this.loadEmbodimentReference()
      : null;
    const referenceBlock = embodimentReference
      ? parseDataUrlImageContent(embodimentReference.dataUrl)
      : null;
    const activeReference = referenceBlock && embodimentReference
      ? { id: embodimentReference.id, description: embodimentReference.description }
      : null;
    const question = activeReference
      ? [
          baseQuestion,
          'The FIRST attached image is my active identity reference; the remaining'
          + ' image(s) are the new render(s) to review against it.',
          activeReference.description
            ? `Reference description: ${activeReference.description}`
            : '',
          'Assess whether the render still depicts the same person as the reference.'
          + ' End your reply with a single line exactly in this form:'
          + ' EMBODIMENT: <same_me|drifted|different_person> — <short reason>.',
        ].filter((line) => line.length > 0).join('\n')
      : baseQuestion;
    const context = {
      systemPrompt: [
        'You are the companion\'s vision review path.',
        'Inspect the attached image content directly.',
        'Answer concretely, keep it concise, and do not tell the Participant to check the image for you.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          ...(referenceBlock ? [referenceBlock] : []),
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
          throw new VisionEmptyResponseError(response.model);
        }
        const embodiment = activeReference
          ? parseEmbodimentConsistency(summary, activeReference)
          : undefined;
        return {
          question,
          summary,
          model: response.model,
          imageCount: imageBlocks.length,
          ...(embodiment ? { embodiment } : {}),
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
      throw new VisionEmptyResponseError(response.model ?? String(model.id));
    }
    const embodiment = activeReference
      ? parseEmbodimentConsistency(summary, activeReference)
      : undefined;
    return {
      question,
      summary,
      model: response.model ?? String(model.id),
      imageCount: imageBlocks.length,
      ...(embodiment ? { embodiment } : {}),
    };
  }

  private async loadEmbodimentReference(): Promise<{
    id: string;
    dataUrl: string;
    description: string;
  } | null> {
    const resolver = this.options.referenceResolver;
    if (!resolver) return null;
    try {
      return await resolver.resolveForTool({ useDefaultReference: true });
    } catch (error) {
      // A missing/unreadable reference must not fail the vision review; the
      // review still runs, it just carries no embodiment descriptor.
      log.warn('Embodiment reference load failed; continuing without descriptor', {
        error: toErrorMessage(error),
      });
      return null;
    }
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
