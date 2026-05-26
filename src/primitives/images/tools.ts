import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ImageOperations } from './ops.js';
import { isFalContentPolicyError } from './fal.js';
import type {
  ImageReferenceSelector,
  ResolvedImageReference,
} from './reference-store.js';
import { getVisionToolRequestContext } from './request-context.js';
import { textResultWithError } from '../../core/tools/results.js';
import { chargeSurface } from '../../shared/telemetry/run-charge.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';
import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  IMAGE_ASPECT_RATIO_VALUES,
  IMAGE_PROVIDER_PREFERENCE_VALUES,
  type ImageAspectRatio,
  type ImageGenerationResult,
  type MediaToolResultDetails,
  type ImageToolResultDetails,
  type ImageVisionReview,
  type ImageVisionReviewer,
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
  reference_image_id?: string;
  reference_image_tags?: string[];
  use_default_reference?: boolean;
}

export interface ImageReferenceResolver {
  resolveForTool(selector: ImageReferenceSelector): Promise<ResolvedImageReference | null>;
}

function formatResult(result: ImageGenerationResult): string {
  return JSON.stringify({
    ...result,
    images: result.images.map(({ localPath: _localPath, ...image }) => image),
  }, null, 2);
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
  notice?: string,
): TextContent[] {
  const content: TextContent[] = [];
  if (notice) {
    content.push({ type: 'text', text: notice });
  }
  content.push({ type: 'text', text: formatResult(result) });
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

function buildImageCreateDescription(selfImage: boolean): string {
  if (selfImage) {
    return 'Generate a dedicated selfie or self-portrait of the companion. Use this explicit path when the request is specifically about her own representation; the runtime Appearance context is loaded for this tool only. When a default reference photo is configured, this tool uses it through the image-edit pipeline unless use_reference_image=false; choose reference_image_id or reference_image_tags for a different saved reference. If the provider blocks the request for content policy, do not retry minor prompt variants in the same turn; report the block and ask for a safer non-explicit direction. Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful generations also return a vision review of the produced image, so use that instead of asking the user to check whether it looks like you unless you need their aesthetic preference.';
  }
  return 'Generate a new image. Write the prompt as the full image you want to create, including subject, framing, pose, lighting, setting, mood, and style. For selfies or self-portraits, use the dedicated selfie_create tool instead of this generic path. Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful generations also return a vision review of the produced image, so use that instead of asking the user to check whether it looks like you unless you need their aesthetic preference.';
}

function buildImageCreatePromptDescription(selfImage: boolean): string {
  if (selfImage) {
    return 'Full generation prompt for a selfie or self-portrait. The runtime Appearance context is available on this tool; combine it with the desired pose, camera angle, lighting, background, and style.';
  }
  return 'Full generation prompt. For selfies or self-portraits, use the dedicated selfie_create tool instead of this generic path.';
}

function referenceSelectionSchema() {
  return {
    reference_image_id: Type.Optional(Type.String({
      description: 'Saved reference photo id to include as an image-edit input.',
    })),
    reference_image_tags: Type.Optional(Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 6,
      description: 'Saved reference tags to match when selecting a reference photo.',
    })),
  };
}

function normalizeReferenceTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

async function resolveReferenceImage(
  resolver: ImageReferenceResolver | undefined,
  input: {
    reference_image_id?: string;
    reference_image_tags?: string[];
    use_reference_image?: boolean;
    use_default_reference?: boolean;
  },
  options: {
    defaultToSavedReference: boolean;
  },
): Promise<ResolvedImageReference | null> {
  if (!resolver) return null;
  if (input.use_reference_image === false) return null;
  const referenceImageId = input.reference_image_id?.trim();
  if (referenceImageId === 'none') return null;
  const referenceImageTags = normalizeReferenceTags(input.reference_image_tags);
  const useDefaultReference = input.use_default_reference === true
    || (options.defaultToSavedReference && !referenceImageId && referenceImageTags.length === 0);
  if (!referenceImageId && referenceImageTags.length === 0 && !useDefaultReference) {
    return null;
  }

  return await resolver.resolveForTool({
    ...(referenceImageId ? { referenceImageId } : {}),
    ...(referenceImageTags.length > 0 ? { referenceImageTags } : {}),
    useDefaultReference,
  });
}

function appendReferenceImageUrl(
  inputUrls: string[],
  reference: ResolvedImageReference | null,
): string[] {
  if (!reference) return inputUrls;
  if (inputUrls.length >= 4) {
    throw new Error('Reference photo plus input images exceeds the four-image edit limit');
  }
  return [...inputUrls, reference.dataUrl];
}

async function reviewGeneratedImages(
  reviewer: ImageVisionReviewer | undefined,
  input: {
    imageUrls: string[];
    imageLocalPaths?: string[];
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
    chargeVisionConsult('image_review', {
      mode: input.mode,
      imageCount: input.imageUrls.length,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
    return {
      visionReview: await reviewer.analyze({
        imageUrls: input.imageUrls,
        ...(input.imageLocalPaths ? { imageLocalPaths: input.imageLocalPaths } : {}),
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

function chargePaidImageGeneration(result: ImageGenerationResult, action: 'generate' | 'edit'): void {
  if (result.provider !== 'fal') {
    return;
  }
  chargeSurface('paidImageGeneration', {
    details: {
      action,
      provider: result.provider,
      ...(result.model ? { model: result.model } : {}),
      imageCount: result.images.length,
    },
  });
}

function chargeVisionConsult(source: string, details: Record<string, unknown>): void {
  chargeSurface('externalModelConsult', {
    details: {
      source,
      ...details,
    },
  });
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

function isProviderContentPolicyError(error: unknown): boolean {
  if (isFalContentPolicyError(error)) {
    return true;
  }
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('content_policy')
    || message.includes('content policy')
    || message.includes('content checker')
    || message.includes('flagged by a content checker')
    || message.includes('safety checker')
    || message.includes('moderation')
    || message.includes('nsfw');
}

function contentPolicyBlockedResult<TDetails extends { isError?: boolean }>(
  toolName: string,
  error: unknown,
  options?: {
    fallbackError?: unknown;
  },
): AgentToolResult<TDetails> {
  const fallbackBlocked = options?.fallbackError !== undefined;
  const message = [
    `${toolName} was blocked by the image provider content policy.`,
    fallbackBlocked
      ? 'A fresh-generation fallback was attempted and was also blocked.'
      : 'The provider rejected this image request.',
    'Do not retry the same prompt or minor wording variants in this turn; stop tool attempts, tell the user the provider blocked the image request, and ask for a safer non-explicit direction.',
    `Provider error: ${toErrorMessage(error)}`,
    ...(fallbackBlocked ? [`Fallback error: ${toErrorMessage(options.fallbackError)}`] : []),
  ].join(' ');
  return textResultWithError(message, true) as AgentToolResult<TDetails>;
}

function buildSelfImageContentPolicyFallbackPrompt(prompt: string): string {
  const sanitized = prompt
    .replace(/\b(sexy|sensual|seductive|flirty|sultry|erotic|provocative|boudoir)\b/gi, 'confident')
    .replace(/\boff[- ]shoulder\b/gi, 'cozy')
    .replace(/\brumpled sheets?\b/gi, 'soft decor')
    .replace(/\bbedroom\b/gi, 'studio interior')
    .replace(/\binviting\b/gi, 'warm')
    .replace(/\bknowing smile\b/gi, 'gentle smile')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
  const basePrompt = sanitized || 'A tasteful companion self-portrait';
  return [
    basePrompt,
    'Tasteful fully clothed companion self-portrait.',
    'Natural everyday styling, calm confident expression, non-explicit pose, neutral indoor background.',
  ].join(' ');
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
      model: params.model as typeof FAL_CREATE_MODELS[number] | undefined,
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
      sourceToolName: 'media',
    });
    chargePaidImageGeneration(result, 'generate');
    const review = await reviewGeneratedImages(reviewer, {
      imageUrls: result.images.map((image) => image.url),
      imageLocalPaths: result.images.map((image) => image.localPath?.trim() ?? ''),
      prompt,
      mode: 'create',
    });
    return {
      content: buildToolContent(result, review.visionReview, review.visionReviewError),
      details: buildMediaResultDetails(result, review.visionReview, review.visionReviewError),
    };
  } catch (error) {
    if (isProviderContentPolicyError(error)) {
      return contentPolicyBlockedResult<MediaToolResultDetails>('media generate', error);
    }
    return textResultWithError(`media generate failed: ${toErrorMessage(error)}`, true);
  }
}

async function executeMediaEdit(
  ops: ImageOperations,
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
  referenceResolver?: ImageReferenceResolver,
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
    const reference = await resolveReferenceImage(referenceResolver, params, {
      defaultToSavedReference: false,
    });
    const imageUrls = appendReferenceImageUrl(inputUrls, reference);
    const result = await ops.edit({
      prompt,
      imageUrls,
      provider: params.provider,
      model: params.model as typeof FAL_EDIT_MODELS[number] | undefined,
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
      sourceToolName: 'media',
      ...(reference ? { referenceImageIds: [reference.id] } : {}),
    });
    chargePaidImageGeneration(result, 'edit');
    const review = await reviewGeneratedImages(reviewer, {
      imageUrls: result.images.map((image) => image.url),
      imageLocalPaths: result.images.map((image) => image.localPath?.trim() ?? ''),
      prompt,
      mode: 'edit',
    });
    return {
      content: buildToolContent(result, review.visionReview, review.visionReviewError),
      details: buildMediaResultDetails(result, review.visionReview, review.visionReviewError),
    };
  } catch (error) {
    if (isProviderContentPolicyError(error)) {
      return contentPolicyBlockedResult<MediaToolResultDetails>('media edit', error);
    }
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

    chargeVisionConsult('image_analyze', {
      imageCount: inputUrls.length,
      ...(params.question ? { question: params.question } : {}),
    });
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
  options?: {
    referenceResolver?: ImageReferenceResolver;
  },
): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'media',
    label: 'media',
    description:
      'Unified media surface for generate, edit, and analyze actions. Use action="generate" for new image outputs, action="edit" to transform existing inputs, and action="analyze" to inspect visible contents. For selfies or self-portraits, use the dedicated selfie_create tool so appearance context is only loaded behind that explicit gate. Current implementation is image-backed.',
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
      ...referenceSelectionSchema(),
      use_default_reference: Type.Optional(Type.Boolean({
        description: 'Include the configured default reference photo as an additional edit input.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: MediaToolParams,
    ): Promise<AgentToolResult<MediaToolResultDetails>> => {
      switch (params.action) {
        case 'generate':
          return await executeMediaGenerate(ops, reviewer, params);
        case 'edit':
          return await executeMediaEdit(ops, reviewer, params, options?.referenceResolver);
        case 'analyze':
          return await executeMediaAnalyze(reviewer, params);
        default:
          return textResultWithError(`Unsupported media action: ${String(params.action)}`, true);
      }
    },
  };

  return tagToolWithReversibility(withCapabilityRequirement(tool, 'external.web'), 'irreversible');
}

export function createImageCreateTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
  options?: {
    selfImage?: boolean;
    toolName?: string;
    referenceResolver?: ImageReferenceResolver;
  },
): AgentTool<any> {
  const selfImage = options?.selfImage ?? false;
  const toolName = options?.toolName ?? 'image_create';
  const parameterShape = {
    prompt: Type.String({
      description: buildImageCreatePromptDescription(selfImage),
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
    ...(selfImage
      ? {
          ...referenceSelectionSchema(),
          use_reference_image: Type.Optional(Type.Boolean({
            description: 'Set false to generate without a saved reference photo.',
          })),
          edit_model: Type.Optional(Type.Union(FAL_EDIT_MODELS.map((value) => Type.Literal(value)))),
        }
      : {}),
  };
  return {
    name: toolName,
    label: toolName,
    description: buildImageCreateDescription(selfImage),
    parameters: Type.Object(parameterShape),
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
        reference_image_id?: string;
        reference_image_tags?: string[];
        use_reference_image?: boolean;
        edit_model?: typeof FAL_EDIT_MODELS[number];
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const reference = selfImage
          ? await resolveReferenceImage(options?.referenceResolver, params, {
              defaultToSavedReference: true,
            })
          : null;
        let mode: 'create' | 'edit' = reference ? 'edit' : 'create';
        let reviewPrompt = params.prompt;
        let notice: string | undefined;
        let result: ImageGenerationResult;
        if (reference) {
          try {
            result = await ops.edit({
              prompt: params.prompt,
              imageUrls: [reference.dataUrl],
              provider: params.provider,
              model: params.edit_model,
              numImages: params.num_images,
              width: params.width,
              height: params.height,
              aspectRatio: params.aspect_ratio,
              resolution: params.resolution,
              imageSize: params.image_size,
              background: params.background,
              outputFormat: params.output_format,
              seed: params.seed,
              sourceToolName: toolName,
              referenceImageIds: [reference.id],
            });
          } catch (error) {
            if (!selfImage || !isProviderContentPolicyError(error)) {
              throw error;
            }
            const fallbackPrompt = buildSelfImageContentPolicyFallbackPrompt(params.prompt);
            try {
              const fallbackResult = await ops.create({
                prompt: fallbackPrompt,
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
                sourceToolName: toolName,
              });
              result = {
                ...fallbackResult,
                fallbackUsed: true,
                fallbackReason: fallbackResult.fallbackReason
                  ?? 'selfie_reference_content_policy_fresh_generation',
              };
              mode = 'create';
              reviewPrompt = fallbackPrompt;
              notice = [
                'Reference image edit was blocked by the image provider content policy.',
                'Generated a fresh non-reference self-portrait with a safer prompt instead.',
              ].join(' ');
            } catch (fallbackError) {
              if (isProviderContentPolicyError(fallbackError)) {
                return contentPolicyBlockedResult<ImageToolResultDetails>(toolName, error, {
                  fallbackError,
                });
              }
              throw fallbackError;
            }
          }
        } else {
          result = await ops.create({
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
              sourceToolName: toolName,
            });
        }
        chargePaidImageGeneration(result, mode === 'edit' ? 'edit' : 'generate');
        const review = await reviewGeneratedImages(reviewer, {
          imageUrls: result.images.map((image) => image.url),
          imageLocalPaths: result.images.map((image) => image.localPath?.trim() ?? ''),
          prompt: reviewPrompt,
          mode,
        });
        return {
          content: buildToolContent(result, review.visionReview, review.visionReviewError, notice),
          details: {
            imageResult: result,
            ...(review.visionReview ? { visionReview: review.visionReview } : {}),
            ...(review.visionReviewError ? { visionReviewError: review.visionReviewError } : {}),
          },
        };
      } catch (error) {
        if (isProviderContentPolicyError(error)) {
          return contentPolicyBlockedResult<ImageToolResultDetails>(toolName, error);
        }
        return textResultWithError(`${toolName} failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createSelfieTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
  options?: {
    referenceResolver?: ImageReferenceResolver;
  },
): AgentTool<any> {
  return createImageCreateTool(ops, reviewer, {
    selfImage: true,
    toolName: 'selfie_create',
    referenceResolver: options?.referenceResolver,
  });
}

export function createImageEditTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
  options?: {
    referenceResolver?: ImageReferenceResolver;
  },
): AgentTool<any> {
  return {
    name: 'image_edit',
    label: 'image_edit',
    description:
      'Edit one or more existing images. Write the prompt as the exact transformation you want, including what should change and what must stay the same. For self-image work, use the dedicated selfie_create tool for a fresh companion representation instead of relying on hidden appearance context. Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful edits also return a vision review of the produced image, so use that instead of asking the user to check whether it still looks like you unless you need their aesthetic preference.',
    parameters: Type.Object({
      prompt: Type.String({
        description:
          'Full edit instruction. State the target result clearly and mention any identity details that must remain unchanged; for self-image work, use the dedicated selfie_create tool instead of relying on hidden appearance context.',
      }),
      image_urls: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
      ...referenceSelectionSchema(),
      use_default_reference: Type.Optional(Type.Boolean({
        description: 'Include the configured default reference photo as an additional edit input.',
      })),
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
        reference_image_id?: string;
        reference_image_tags?: string[];
        use_default_reference?: boolean;
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const reference = await resolveReferenceImage(options?.referenceResolver, params, {
          defaultToSavedReference: false,
        });
        const imageUrls = appendReferenceImageUrl([...params.image_urls], reference);
        const result = await ops.edit({
          prompt: params.prompt,
          imageUrls,
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
          sourceToolName: 'image_edit',
          ...(reference ? { referenceImageIds: [reference.id] } : {}),
        });
        chargePaidImageGeneration(result, 'edit');
        const review = await reviewGeneratedImages(reviewer, {
          imageUrls: result.images.map((image) => image.url),
          imageLocalPaths: result.images.map((image) => image.localPath?.trim() ?? ''),
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
        if (isProviderContentPolicyError(error)) {
          return contentPolicyBlockedResult<ImageToolResultDetails>('image_edit', error);
        }
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
        const currentTurnVisionReviewFallback = resolveCurrentTurnVisionReviewFallback(
          params.image_urls,
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

        const mismatchedCurrentTurnUrlNotice = resolveMismatchedCurrentTurnUrlNotice(params.image_urls);
        if (mismatchedCurrentTurnUrlNotice) {
          return {
            content: [{ type: 'text', text: mismatchedCurrentTurnUrlNotice }] satisfies TextContent[],
            details: { visionReviewError: mismatchedCurrentTurnUrlNotice },
          };
        }

        chargeVisionConsult('image_analyze', {
          imageCount: params.image_urls.length,
          ...(params.question ? { question: params.question } : {}),
        });
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
