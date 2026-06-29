import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ImageOperations } from './ops.js';
import { isFalContentPolicyError, isTransientFalError } from './fal.js';
import type {
  ImageReferenceSelector,
  ResolvedImageReference,
} from './reference-store.js';
import { getVisionToolRequestContext } from './request-context.js';
import { textResultWithError } from '../../core/tools/results.js';
import {
  assertChargeSurfaceAvailable,
  chargeSurface,
} from '../../shared/telemetry/run-charge.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
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

// Reference-selfie edit tiers, strictest/highest-fidelity first. Every tier is an
// edit endpoint so the saved reference photo always anchors the result; on a
// content-policy block or timeout the chain advances to the next, more permissive tier.
const SELFIE_EDIT_MODEL_CHAIN = [
  'openai/gpt-image-2/edit',
  'fal-ai/nano-banana-2/edit',
  'xai/grok-imagine-image/quality/edit',
] as const satisfies readonly typeof FAL_EDIT_MODELS[number][];

const SELFIE_EDIT_MODEL_DESCRIPTION = [
  'Starting edit-model tier for the reference selfie.',
  'Tiers, strictest first: openai/gpt-image-2/edit (highest fidelity, strictest content filter, slow - can take minutes),',
  'fal-ai/nano-banana-2/edit (fast, strong fidelity), xai/grok-imagine-image/quality/edit (most permissive filter).',
  'On a content-policy block or timeout the tool automatically falls through to the next tier, always keeping the reference image.',
  'For casual but filter-sensitive looks (swimwear, beachwear, tank tops, fitted or shoulder-baring outfits), start directly at fal-ai/nano-banana-2/edit or xai/grok-imagine-image/quality/edit instead of waiting out a gpt-image false-positive block.',
].join(' ');

function resolveSelfieEditModelChain(
  startModel: typeof FAL_EDIT_MODELS[number] | undefined,
): readonly typeof FAL_EDIT_MODELS[number][] {
  if (!startModel) {
    return SELFIE_EDIT_MODEL_CHAIN;
  }
  const startIndex = (SELFIE_EDIT_MODEL_CHAIN as readonly string[]).indexOf(startModel);
  if (startIndex >= 0) {
    return SELFIE_EDIT_MODEL_CHAIN.slice(startIndex);
  }
  // Off-chain start (e.g. grok speed mode or gpt-image-1.5): try it, then fall
  // through the non-gpt tiers rather than escalating back to a stricter model.
  return [startModel, ...SELFIE_EDIT_MODEL_CHAIN.slice(1).filter((model) => model !== startModel)];
}

function shouldFallThroughSelfieEditChain(error: unknown): boolean {
  return isProviderContentPolicyError(error) || isTransientFalError(error);
}

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

function buildImageCreateDescription(selfImage: boolean): string {
  if (selfImage) {
    return 'Generate a dedicated selfie or self-portrait of the companion; the result does not have to be a literal selfie angle - any portrait of her works. Use this explicit path when the request is specifically about her own representation; the always-on appearance context is the identity anchor, and this tool adds the self-image reference workflow. When a default reference photo is configured, use_reference_image=true anchors her likeness; set use_reference_image=false only when the user explicitly wants no saved reference. Use reference_image_id or reference_image_tags to choose a different saved reference. If the provider blocks the request for content policy, report the block and ask for a safer non-explicit direction instead of retrying minor prompt variants. Successful generations return a vision review of the produced image.';
  }
  return 'Generate a new image. Write the prompt as the full image you want to create, including subject, framing, pose, lighting, setting, mood, and style. For selfies or self-portraits, use the first-class selfie_create tool instead of this generic path. Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful generations also return a vision review of the produced image, so use that instead of asking the user to check whether it looks like you unless you need their aesthetic preference.';
}

function buildImageCreatePromptDescription(selfImage: boolean): string {
  if (selfImage) {
    return 'Full generation prompt for a selfie or self-portrait. Combine the always-on appearance context with the desired pose, camera angle, lighting, background, and style.';
  }
  return 'Full generation prompt. For selfies or self-portraits, use the first-class selfie_create tool instead of this generic path.';
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

function preflightPaidImageGeneration(input: {
  action: 'generate' | 'edit';
  provider?: 'auto' | 'fal' | 'comfyui';
  model?: string;
  imageCount?: number;
  inputImageCount?: number;
}): void {
  if (input.provider === 'comfyui') {
    return;
  }
  assertChargeSurfaceAvailable('paidImageGeneration', {
    details: {
      action: input.action,
      provider: input.provider ?? 'auto',
      ...(input.model ? { model: input.model } : {}),
      imageCount: input.imageCount ?? 1,
      ...(input.inputImageCount !== undefined ? { inputImageCount: input.inputImageCount } : {}),
    },
  });
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
      ? 'A safer edit fallback was attempted and was also blocked.'
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
    preflightPaidImageGeneration({
      action: 'generate',
      provider: params.provider,
      model: params.model,
      imageCount: params.num_images,
    });
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
    preflightPaidImageGeneration({
      action: 'edit',
      provider: params.provider,
      model: params.model,
      imageCount: params.num_images,
      inputImageCount: imageUrls.length,
    });
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

    chargeVisionConsult('media_analyze', {
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
      'Unified media surface for generate, edit, and analyze actions. Use action="generate" for new image outputs, action="edit" to transform existing inputs, and action="analyze" to inspect visible contents. For selfies, portraits, or self-representation, use the first-class selfie_create tool so the self-expression reference workflow is active. Current implementation is image-backed.',
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

  return tagToolWithReversibility(tool, 'irreversible');
}

function createImageGenerationTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
  options?: {
    selfImage?: boolean;
    toolName?: string;
    referenceResolver?: ImageReferenceResolver;
  },
): AgentTool<any> {
  const selfImage = options?.selfImage ?? false;
  const toolName = options?.toolName ?? 'selfie_create';
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
          edit_model: Type.Optional(Type.Union(
            FAL_EDIT_MODELS.map((value) => Type.Literal(value)),
            { description: SELFIE_EDIT_MODEL_DESCRIPTION },
          )),
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
          preflightPaidImageGeneration({
            action: 'edit',
            provider: params.provider,
            model: params.edit_model,
            imageCount: params.num_images,
            inputImageCount: 1,
          });
          const runReferenceEdit = async (
            editModel: typeof FAL_EDIT_MODELS[number],
            editPrompt: string,
          ): Promise<ImageGenerationResult> => await ops.edit({
            prompt: editPrompt,
            imageUrls: [reference.dataUrl],
            provider: params.provider,
            model: editModel,
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

          const editChain = resolveSelfieEditModelChain(params.edit_model);
          const chainFailures: { model: string; error: unknown }[] = [];
          let chainResult: ImageGenerationResult | null = null;
          for (const editModel of editChain) {
            try {
              chainResult = await runReferenceEdit(editModel, params.prompt);
              break;
            } catch (error) {
              if (!shouldFallThroughSelfieEditChain(error)) {
                throw error;
              }
              chainFailures.push({ model: editModel, error });
            }
          }

          if (!chainResult) {
            const lastFailure = chainFailures[chainFailures.length - 1]!;
            const allBlockedByContentPolicy = chainFailures.every(
              (failure) => isProviderContentPolicyError(failure.error),
            );
            if (!allBlockedByContentPolicy) {
              const failureSummary = chainFailures
                .map((failure) => `${failure.model}: ${toErrorMessage(failure.error)}`)
                .join('; ');
              return textResultWithError(
                `${toolName} failed across all reference edit models (${failureSummary})`,
                true,
              );
            }
            // Every tier blocked the original prompt; last resort is a sanitized
            // prompt on the most permissive tier, still anchored to the reference.
            const fallbackPrompt = buildSelfImageContentPolicyFallbackPrompt(params.prompt);
            const finalModel = editChain[editChain.length - 1]!;
            try {
              chainResult = await runReferenceEdit(finalModel, fallbackPrompt);
              reviewPrompt = fallbackPrompt;
              result = {
                ...chainResult,
                fallbackUsed: true,
                fallbackReason: chainResult.fallbackReason
                  ?? 'selfie_edit_chain_sanitized_prompt',
              };
              notice = [
                'Every selfie edit model blocked the original prompt for content policy.',
                `Retried the reference edit on ${finalModel} with a safer prompt instead.`,
              ].join(' ');
            } catch (fallbackError) {
              if (isProviderContentPolicyError(fallbackError)) {
                return contentPolicyBlockedResult<ImageToolResultDetails>(toolName, lastFailure.error, {
                  fallbackError,
                });
              }
              throw fallbackError;
            }
          } else if (chainFailures.length > 0) {
            result = {
              ...chainResult,
              fallbackUsed: true,
              fallbackReason: chainResult.fallbackReason ?? 'selfie_edit_chain_fallback',
            };
            notice = [
              ...chainFailures.map((failure) => (
                `Selfie edit on ${failure.model} failed (${isProviderContentPolicyError(failure.error) ? 'content policy block' : 'timeout or provider error'}).`
              )),
              `Fell back to ${chainResult.model ?? 'the next edit tier'} with the reference image intact.`,
            ].join(' ');
          } else {
            result = chainResult;
          }
        } else {
          preflightPaidImageGeneration({
            action: 'generate',
            provider: params.provider,
            model: params.model,
            imageCount: params.num_images,
          });
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
  return createImageGenerationTool(ops, reviewer, {
    selfImage: true,
    toolName: 'selfie_create',
    referenceResolver: options?.referenceResolver,
  });
}
