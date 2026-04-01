import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ImageOperations } from './ops.js';
import { getVisionToolRequestContext } from './request-context.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  IMAGE_ASPECT_RATIO_VALUES,
  IMAGE_PROVIDER_PREFERENCE_VALUES,
  type ImageAspectRatio,
  type ImageCreateParams,
  type ImageEditParams,
  type ImageGenerationResult,
  type ImageVisionReview,
  type ImageVisionReviewer,
  type MediaToolResultDetails,
} from './types.js';

const IMAGE_ASPECT_RATIO_DESCRIPTION = [
  'Optional preset aspect ratio.',
  'Common values: 1:1 square, 3:4 portrait, 9:16 story, 4:3 landscape, 16:9 wide.',
  'Use only one of the supported presets.',
].join(' ');
const MEDIA_ACTION_VALUES = ['generate', 'edit', 'analyze'] as const;

type MediaAction = typeof MEDIA_ACTION_VALUES[number];

interface MediaToolParams {
  action: MediaAction;
  prompt?: string;
  input_urls?: string[];
  question?: string;
  provider?: 'auto' | 'fal' | 'comfyui';
  model?: string;
  num_images?: number;
  width?: number;
  height?: number;
  aspect_ratio?: ImageAspectRatio;
  resolution?: string;
  image_size?: string;
  background?: string;
  output_format?: string;
  mask_image_url?: string;
  input_fidelity?: string;
  seed?: number;
  guidance_scale?: number;
  num_inference_steps?: number;
  acceleration?: string;
  enable_prompt_expansion?: boolean;
  enable_safety_checker?: boolean;
  negative_prompt?: string;
  use_turbo?: boolean;
}

function formatResult(result: ImageGenerationResult): string {
  return JSON.stringify(result, null, 2);
}

function formatVisionReview(review: ImageVisionReview): string {
  return [
    'Vision review:',
    review.summary,
  ].join('\n');
}

function buildToolContent(
  result: ImageGenerationResult,
  review?: ImageVisionReview,
  reviewError?: string,
): TextContent[] {
  const content: TextContent[] = [
    { type: 'text', text: formatResult(result) },
  ];
  if (review) {
    content.push({ type: 'text', text: formatVisionReview(review) });
  } else if (reviewError) {
    content.push({
      type: 'text',
      text: `Vision review unavailable: ${reviewError}`,
    });
  }
  return content;
}

function providerPreferenceSchema() {
  return Type.Optional(Type.Union(
    IMAGE_PROVIDER_PREFERENCE_VALUES.map((value) => Type.Literal(value)),
  ));
}

function aspectRatioSchema() {
  return Type.Optional(Type.Union(
    IMAGE_ASPECT_RATIO_VALUES.map((value) => Type.Literal(value)),
    {
      description: IMAGE_ASPECT_RATIO_DESCRIPTION,
    },
  ));
}

function normalizeUrlForTurnComparison(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function resolveMismatchedCurrentTurnUrlNotice(imageUrls: readonly string[]): string | null {
  const requestContext = getVisionToolRequestContext();
  if (!requestContext || requestContext.imageAttachmentUrls.length === 0) {
    return null;
  }

  const currentTurnRawAttachmentUrls = new Set(
    requestContext.imageAttachmentUrls
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
  );
  const currentTurnAttachmentUrls = new Set(
    requestContext.imageAttachmentUrls
      .map(normalizeUrlForTurnComparison)
      .filter((url): url is string => url !== null),
  );

  for (const rawUrl of imageUrls) {
    const trimmedUrl = rawUrl.trim();
    if (!trimmedUrl) continue;
    if (requestContext.userMessageText.includes(trimmedUrl)) continue;
    if (currentTurnRawAttachmentUrls.has(trimmedUrl)) continue;

    const normalizedUrl = normalizeUrlForTurnComparison(trimmedUrl);
    if (normalizedUrl && currentTurnAttachmentUrls.has(normalizedUrl)) continue;

    return [
      'Current turn already includes live image attachment bytes.',
      'The URL passed to media action="analyze" does not match a current-turn attachment and may be stale or refer to a different image.',
      'Do not use a mismatched prior-turn URL for this turn.',
      'Inspect the current attached image already in context, or ask the user to resend or paste the specific URL if they want a different image checked.',
    ].join(' ');
  }

  return null;
}

function resolveCurrentTurnVisionReviewFallback(
  imageUrls: readonly string[],
  question?: string,
): ImageVisionReview | null {
  const mismatchedCurrentTurnUrlNotice = resolveMismatchedCurrentTurnUrlNotice(imageUrls);
  if (!mismatchedCurrentTurnUrlNotice) {
    return null;
  }

  const currentTurnVisionReview = getVisionToolRequestContext()?.currentTurnVisionReview;
  if (!currentTurnVisionReview) {
    return null;
  }

  return {
    question: question?.trim() || currentTurnVisionReview.question,
    summary: currentTurnVisionReview.summary,
    model: 'current-turn-review',
    imageCount: currentTurnVisionReview.imageUrls.length,
  };
}

async function reviewGeneratedImages(
  reviewer: ImageVisionReviewer | undefined,
  input: {
    imageUrls: string[];
    prompt: string;
    mode: 'create' | 'edit';
  },
): Promise<{
  visionReview?: ImageVisionReview;
  visionReviewError?: string;
}> {
  if (!reviewer) {
    return {};
  }

  try {
    return {
      visionReview: await reviewer.analyze({
        imageUrls: input.imageUrls,
        prompt: input.prompt,
        mode: input.mode,
      }),
    };
  } catch (error) {
    return {
      visionReviewError: toErrorMessage(error),
    };
  }
}

function buildMediaResultDetails(
  result: ImageGenerationResult,
  review?: ImageVisionReview,
  reviewError?: string,
): MediaToolResultDetails {
  return {
    mediaResult: result,
    ...(review ? { visionReview: review } : {}),
    ...(reviewError ? { visionReviewError: reviewError } : {}),
  };
}

function normalizePrompt(prompt: string | undefined): string | null {
  const normalized = prompt?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeInputUrls(inputUrls: readonly string[] | undefined): string[] {
  return (inputUrls ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 4);
}

async function executeMediaGenerate(
  ops: ImageOperations,
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
): Promise<AgentToolResult<MediaToolResultDetails>> {
  const prompt = normalizePrompt(params.prompt);
  if (!prompt) {
    return textResultWithError('media action "generate" requires a non-empty prompt', true);
  }

  try {
    const result = await ops.create({
      prompt,
      provider: params.provider,
      model: params.model as ImageCreateParams['model'],
      numImages: params.num_images,
      width: params.width,
      height: params.height,
      aspectRatio: params.aspect_ratio,
      resolution: params.resolution,
      imageSize: params.image_size,
      background: params.background,
      outputFormat: params.output_format,
      seed: params.seed,
      guidanceScale: params.guidance_scale,
      numInferenceSteps: params.num_inference_steps,
      acceleration: params.acceleration,
      enablePromptExpansion: params.enable_prompt_expansion,
      enableSafetyChecker: params.enable_safety_checker,
      negativePrompt: params.negative_prompt,
      useTurbo: params.use_turbo,
    });
    const review = await reviewGeneratedImages(reviewer, {
      imageUrls: result.images.map((image) => image.url),
      prompt,
      mode: 'create',
    });
    return {
      content: buildToolContent(result, review.visionReview, review.visionReviewError),
      details: buildMediaResultDetails(result, review.visionReview, review.visionReviewError),
    };
  } catch (error) {
    return textResultWithError(`media generate failed: ${toErrorMessage(error)}`, true);
  }
}

async function executeMediaEdit(
  ops: ImageOperations,
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
): Promise<AgentToolResult<MediaToolResultDetails>> {
  const prompt = normalizePrompt(params.prompt);
  if (!prompt) {
    return textResultWithError('media action "edit" requires a non-empty prompt', true);
  }

  const inputUrls = normalizeInputUrls(params.input_urls);
  if (inputUrls.length === 0) {
    return textResultWithError('media action "edit" requires at least one input URL', true);
  }

  try {
    const result = await ops.edit({
      prompt,
      imageUrls: inputUrls,
      provider: params.provider,
      model: params.model as ImageEditParams['model'],
      numImages: params.num_images,
      width: params.width,
      height: params.height,
      aspectRatio: params.aspect_ratio,
      resolution: params.resolution,
      imageSize: params.image_size,
      background: params.background,
      outputFormat: params.output_format,
      maskImageUrl: params.mask_image_url,
      inputFidelity: params.input_fidelity,
      seed: params.seed,
    });
    const review = await reviewGeneratedImages(reviewer, {
      imageUrls: result.images.map((image) => image.url),
      prompt,
      mode: 'edit',
    });
    return {
      content: buildToolContent(result, review.visionReview, review.visionReviewError),
      details: buildMediaResultDetails(result, review.visionReview, review.visionReviewError),
    };
  } catch (error) {
    return textResultWithError(`media edit failed: ${toErrorMessage(error)}`, true);
  }
}

async function executeMediaAnalyze(
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
): Promise<AgentToolResult<MediaToolResultDetails>> {
  if (!reviewer) {
    return textResultWithError('media action "analyze" is not available in this runtime', true);
  }

  const inputUrls = normalizeInputUrls(params.input_urls);
  if (inputUrls.length === 0) {
    return textResultWithError('media action "analyze" requires at least one input URL', true);
  }

  try {
    const currentTurnVisionReviewFallback = resolveCurrentTurnVisionReviewFallback(
      inputUrls,
      params.question,
    );
    if (currentTurnVisionReviewFallback) {
      return {
        content: [{
          type: 'text',
          text: formatVisionReview(currentTurnVisionReviewFallback),
        }] satisfies TextContent[],
        details: { visionReview: currentTurnVisionReviewFallback },
      };
    }

    const mismatchedCurrentTurnUrlNotice = resolveMismatchedCurrentTurnUrlNotice(inputUrls);
    if (mismatchedCurrentTurnUrlNotice) {
      return {
        content: [{ type: 'text', text: mismatchedCurrentTurnUrlNotice }] satisfies TextContent[],
        details: { visionReviewError: mismatchedCurrentTurnUrlNotice },
      };
    }

    const visionReview = await reviewer.analyze({
      imageUrls: inputUrls,
      question: params.question,
    });
    return {
      content: [{ type: 'text', text: formatVisionReview(visionReview) }] satisfies TextContent[],
      details: { visionReview },
    };
  } catch (error) {
    return textResultWithError(`media analyze failed: ${toErrorMessage(error)}`, true);
  }
}

export function createMediaTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
): AgentTool<any> {
  return {
    name: 'media',
    label: 'media',
    description:
      'Unified media surface for generate, edit, and analyze actions. Use action="generate" for new outputs, action="edit" to transform existing inputs, and action="analyze" to inspect what is visible in source or generated media. Current implementation is image-backed. Keep detailed prompt craft and provider/model quirks in creator skills via skill action="view" rather than in this tool surface.',
    parameters: Type.Object({
      action: Type.Union(
        MEDIA_ACTION_VALUES.map((value) => Type.Literal(value)),
        {
          description: 'Select whether to generate new media, edit existing inputs, or analyze visible contents.',
        },
      ),
      prompt: Type.Optional(Type.String({
        description: 'Instruction text for generate or edit actions.',
      })),
      input_urls: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 4,
        description: 'Source media URLs for edit or analyze. Current implementation expects image URLs.',
      })),
      question: Type.Optional(Type.String({
        description: 'Optional analysis question. If omitted, the tool returns a concise visible-contents review.',
      })),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.String({
        description: 'Optional provider model override.',
      })),
      num_images: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      aspect_ratio: aspectRatioSchema(),
      resolution: Type.Optional(Type.String()),
      image_size: Type.Optional(Type.String()),
      background: Type.Optional(Type.String()),
      output_format: Type.Optional(Type.String()),
      mask_image_url: Type.Optional(Type.String()),
      input_fidelity: Type.Optional(Type.String()),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      guidance_scale: Type.Optional(Type.Number()),
      num_inference_steps: Type.Optional(Type.Integer({ minimum: 1 })),
      acceleration: Type.Optional(Type.String()),
      enable_prompt_expansion: Type.Optional(Type.Boolean()),
      enable_safety_checker: Type.Optional(Type.Boolean()),
      negative_prompt: Type.Optional(Type.String()),
      use_turbo: Type.Optional(Type.Boolean()),
    }),
    execute: async (
      _toolCallId: string,
      params: MediaToolParams,
    ): Promise<AgentToolResult<MediaToolResultDetails>> => {
      switch (params.action) {
        case 'generate':
          return await executeMediaGenerate(ops, reviewer, params);
        case 'edit':
          return await executeMediaEdit(ops, reviewer, params);
        case 'analyze':
          return await executeMediaAnalyze(reviewer, params);
        default:
          return textResultWithError(`Unsupported media action: ${String(params.action)}`, true);
      }
    },
  };
}
