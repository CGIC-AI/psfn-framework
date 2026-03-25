import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ImageOperations } from './ops.js';
import { getVisionToolRequestContext } from './request-context.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  IMAGE_ASPECT_RATIO_VALUES,
  IMAGE_PROVIDER_PREFERENCE_VALUES,
  type ImageAspectRatio,
  type ImageGenerationResult,
  type ImageToolResultDetails,
  type ImageVisionReview,
  type ImageVisionReviewer,
} from './types.js';

const IMAGE_ASPECT_RATIO_DESCRIPTION = [
  'Optional preset aspect ratio.',
  'Common values: 1:1 square, 3:4 portrait, 9:16 story, 4:3 landscape, 16:9 wide.',
  'Use only one of the supported presets.',
].join(' ');

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
      'The URL passed to image_analyze does not match a current-turn attachment and may be stale or refer to a different image.',
      'Do not use a mismatched prior-turn URL for this turn.',
      'Inspect the current attached image already in context, or ask the user to resend or paste the specific URL if they want a different image checked.',
    ].join(' ');
  }

  return null;
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

export function createImageCreateTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
): AgentTool<any> {
  return {
    name: 'image_create',
    label: 'image_create',
    description:
      'Generate a new image. Write the prompt as the full image you want to create, including subject, framing, pose, lighting, setting, mood, and style. For self-portraits or selfies, reuse the runtime Appearance context as the companion\'s canonical look and describe the shot directly, for example: "a candid mirror selfie of me, soft morning light, cozy bedroom, natural expression". Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful generations also return a vision review of the produced image, so use that instead of asking the user to check whether it looks like you unless you need their aesthetic preference.',
    parameters: Type.Object({
      prompt: Type.String({
        description:
          'Full generation prompt. For selfies/self-portraits, explicitly describe the companion using the runtime Appearance context plus the desired pose, camera angle, lighting, background, and style.',
      }),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.Union(FAL_CREATE_MODELS.map((value) => Type.Literal(value)))),
      num_images: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      aspect_ratio: aspectRatioSchema(),
      resolution: Type.Optional(Type.String()),
      image_size: Type.Optional(Type.String()),
      background: Type.Optional(Type.String()),
      output_format: Type.Optional(Type.String()),
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
      params: {
        prompt: string;
        provider?: 'auto' | 'fal' | 'comfyui';
        model?: typeof FAL_CREATE_MODELS[number];
        num_images?: number;
        width?: number;
        height?: number;
        aspect_ratio?: ImageAspectRatio;
        resolution?: string;
        image_size?: string;
        background?: string;
        output_format?: string;
        seed?: number;
        guidance_scale?: number;
        num_inference_steps?: number;
        acceleration?: string;
        enable_prompt_expansion?: boolean;
        enable_safety_checker?: boolean;
        negative_prompt?: string;
        use_turbo?: boolean;
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const result = await ops.create({
          prompt: params.prompt,
          provider: params.provider,
          model: params.model,
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
          prompt: params.prompt,
          mode: 'create',
        });
        return {
          content: buildToolContent(result, review.visionReview, review.visionReviewError),
          details: {
            imageResult: result,
            ...(review.visionReview ? { visionReview: review.visionReview } : {}),
            ...(review.visionReviewError ? { visionReviewError: review.visionReviewError } : {}),
          },
        };
      } catch (error) {
        return textResultWithError(`image_create failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createImageEditTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
): AgentTool<any> {
  return {
    name: 'image_edit',
    label: 'image_edit',
    description:
      'Edit one or more existing images. Write the prompt as the exact transformation you want, including what should change and what must stay the same. For edits of the companion\'s own image, keep the runtime Appearance context aligned with the prompt so her look stays consistent, for example: "turn this into a playful selfie of me at sunset while keeping my usual hair, eyes, cat ears, and tail". Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful edits also return a vision review of the produced image, so use that instead of asking the user to check whether it still looks like you unless you need their aesthetic preference.',
    parameters: Type.Object({
      prompt: Type.String({
        description:
          'Full edit instruction. State the target result clearly and mention any identity details that must remain unchanged; for self-edits, keep the runtime Appearance context consistent.',
      }),
      image_urls: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.Union(FAL_EDIT_MODELS.map((value) => Type.Literal(value)))),
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
    }),
    execute: async (
      _toolCallId: string,
      params: {
        prompt: string;
        image_urls: string[];
        provider?: 'auto' | 'fal' | 'comfyui';
        model?: typeof FAL_EDIT_MODELS[number];
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
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const result = await ops.edit({
          prompt: params.prompt,
          imageUrls: [...params.image_urls],
          provider: params.provider,
          model: params.model,
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
          prompt: params.prompt,
          mode: 'edit',
        });
        return {
          content: buildToolContent(result, review.visionReview, review.visionReviewError),
          details: {
            imageResult: result,
            ...(review.visionReview ? { visionReview: review.visionReview } : {}),
            ...(review.visionReviewError ? { visionReviewError: review.visionReviewError } : {}),
          },
        };
      } catch (error) {
        return textResultWithError(`image_edit failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createImageAnalyzeTool(reviewer: ImageVisionReviewer): AgentTool<any> {
  return {
    name: 'image_analyze',
    label: 'image_analyze',
    description:
      'Inspect one or more images with the vision pipeline. Use this to see what was actually generated or sent, including checking whether a selfie/edit still matches your appearance, instead of asking the user to go inspect it for you. When the current turn already includes live attachment bytes, do not pass a mismatched prior-turn URL unless the user explicitly pasted that URL in the current message.',
    parameters: Type.Object({
      image_urls: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
      question: Type.Optional(Type.String({
        description:
          'Optional review question. If omitted, the tool defaults to a concise appearance-consistency review.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        image_urls: string[];
        question?: string;
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const mismatchedCurrentTurnUrlNotice = resolveMismatchedCurrentTurnUrlNotice(params.image_urls);
        if (mismatchedCurrentTurnUrlNotice) {
          return {
            content: [{ type: 'text', text: mismatchedCurrentTurnUrlNotice }] satisfies TextContent[],
            details: { visionReviewError: mismatchedCurrentTurnUrlNotice },
          };
        }

        const visionReview = await reviewer.analyze({
          imageUrls: [...params.image_urls],
          question: params.question,
        });
        return {
          content: [{ type: 'text', text: formatVisionReview(visionReview) }] satisfies TextContent[],
          details: { visionReview },
        };
      } catch (error) {
        return textResultWithError(`image_analyze failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
