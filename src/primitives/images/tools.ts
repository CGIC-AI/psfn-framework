import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
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
import { notePendingPaidDeliverable } from '../../shared/paid-deliverable-tracking.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';
import {
  DEFAULT_SELFIE_EDIT_MODEL_CHAIN,
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
const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
const MEDIA_ACTION_VALUES = ['generate', 'edit', 'analyze'] as const;

// Reference-selfie edit tiers come from the image model catalog. Every tier is
// an edit endpoint so the saved reference photo always anchors the result.
const SELFIE_EDIT_MODEL_CHAIN = DEFAULT_SELFIE_EDIT_MODEL_CHAIN;

const SELFIE_EDIT_MODEL_DESCRIPTION = [
  'Optional reference-edit model override for selfie_create.',
  'Usually omit this; the tool chooses a reference-preserving edit path and keeps the saved reference image anchored.',
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
  // through later configured tiers rather than jumping back to the first tier.
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

function resolveGenerationId(result: ImageGenerationResult): string | undefined {
  const fromRequest = result.requestId?.trim();
  if (fromRequest) {
    return fromRequest;
  }
  const fromFileName = result.images.find((image) => image.fileName?.trim())?.fileName?.trim();
  return fromFileName || undefined;
}

function formatResult(result: ImageGenerationResult): string {
  const imageCount = result.images.length;
  const generationId = resolveGenerationId(result);
  return JSON.stringify({
    status: 'image_generated',
    provider: result.provider,
    mode: result.mode,
    ...(result.model ? { model: result.model } : {}),
    imageCount,
    fallbackUsed: result.fallbackUsed,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    ...(generationId ? { generationId } : {}),
    attachmentPending: true,
    delivery: imageCount === 1
      ? 'This image is a pending chat attachment. It will be delivered to the user ONLY when you send your next reply this turn. '
        + 'Send a reply (even one short line) so it reaches them; if you end the turn with no reply, this paid image will NOT be delivered. '
        + 'Reference it by its fileName below.'
      : 'These images are pending chat attachments. They will be delivered to the user ONLY when you send your next reply this turn. '
        + 'Send a reply (even one short line) so they reach them; if you end the turn with no reply, these paid images will NOT be delivered. '
        + 'Reference them by the fileNames below.',
    images: result.images.map((image, index) => ({
      index: index + 1,
      ...(image.contentType ? { contentType: image.contentType } : {}),
      ...(image.fileName ? { fileName: image.fileName } : {}),
      hasLocalFile: Boolean(image.localPath?.trim()),
    })),
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
    {
      description: 'Optional provider preference: auto picks the configured default, fal is the paid hosted provider, comfyui is the local pipeline.',
    },
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
      `The URL passed to ${GENERATE_IMAGE_TOOL_NAME} action="analyze" does not match a current-turn attachment and may be stale or refer to a different image.`,
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
    return 'Send a selfie or self-portrait of yourself. Use it when the user wants an image OF YOU: "send me a selfie", "what do you look like right now", "show yourself in a summer dress". Requires prompt: combine your appearance context with pose, camera angle, lighting, background, and style; the saved-reference anchoring keeps your face consistent by default (set use_reference_image=false only if explicitly asked). Do NOT use this for anything that is not you — other people, scenes, objects, and photo edits belong to generate_image.';
  }
  return 'Generate a new image. Write the prompt as the full image you want to create, including subject, framing, pose, lighting, setting, mood, and style. For selfies or self-portraits of yourself, use the first-class selfie_create tool instead of this generic path. Common aspect ratios: 1:1, 3:4, 9:16, 4:3, 16:9. Successful generations also return a vision review of the produced image, so use that instead of asking the user to check whether it looks like you unless you need their aesthetic preference.';
}

function buildImageCreatePromptDescription(selfImage: boolean): string {
  if (selfImage) {
    return 'Full generation prompt for a selfie or self-portrait. Combine the always-on appearance context with the desired pose, camera angle, lighting, background, and style.';
  }
  return 'Full generation prompt. For selfies or self-portraits of yourself, use the first-class selfie_create tool instead of this generic path.';
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

function chargePaidImageGeneration(
  result: ImageGenerationResult,
  action: 'generate' | 'edit',
  source: { toolName: string; toolCallId?: string },
): void {
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
  // Fal is a paid external surface: a successful generation always incurred real
  // spend and produced a user-facing artifact. Register it as an undelivered
  // paid deliverable so the turn cannot silently end in no-reply and drop it.
  const generationId = resolveGenerationId(result);
  notePendingPaidDeliverable({
    surface: 'paidImageGeneration',
    toolName: source.toolName,
    ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    ...(generationId ? { identifier: generationId } : {}),
    artifactCount: result.images.length,
    artifactKind: 'image',
    provider: result.provider,
    mode: result.mode,
    ...(result.model ? { model: result.model } : {}),
    artifacts: result.images
      .filter((image) => image.url.trim().length > 0)
      .map((image) => ({
        url: image.url,
        ...(image.contentType ? { contentType: image.contentType } : {}),
        ...(image.fileName ? { fileName: image.fileName } : {}),
        ...(image.localPath ? { localPath: image.localPath } : {}),
      })),
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

function resolveInvalidFalModelError(
  action: 'generate' | 'edit',
  provider: MediaToolParams['provider'],
  model: string | undefined,
  validModels: readonly string[],
): AgentToolResult<MediaToolResultDetails> | null {
  if (provider === 'comfyui') return null;
  const normalizedModel = model?.trim();
  if (!normalizedModel) return null;
  if ((validModels as readonly string[]).includes(normalizedModel)) return null;
  return textResultWithError(
    `Invalid "model" value "${normalizedModel}" for ${GENERATE_IMAGE_TOOL_NAME} action="${action}". `
    + `Valid ${action === 'generate' ? 'generation' : 'edit'} models: ${validModels.join(', ')}. `
    + 'Omit "model" to use the default model chain, or set provider="comfyui" for a local ComfyUI model.',
    true,
  );
}

async function executeMediaGenerate(
  ops: ImageOperations,
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
  toolCallId: string,
): Promise<AgentToolResult<MediaToolResultDetails>> {
  const prompt = normalizePrompt(params.prompt);
  if (!prompt) {
    return textResultWithError(
      `Missing required field "prompt" for ${GENERATE_IMAGE_TOOL_NAME} action="generate". `
      + 'Minimal valid JSON: {"action":"generate","prompt":"full image description"}.',
      true,
    );
  }

  const invalidModelError = resolveInvalidFalModelError(
    'generate',
    params.provider,
    params.model,
    FAL_CREATE_MODELS,
  );
  if (invalidModelError) return invalidModelError;

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
      sourceToolName: GENERATE_IMAGE_TOOL_NAME,
    });
    chargePaidImageGeneration(result, 'generate', { toolName: GENERATE_IMAGE_TOOL_NAME, toolCallId });
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
      return contentPolicyBlockedResult<MediaToolResultDetails>(`${GENERATE_IMAGE_TOOL_NAME} generate`, error);
    }
    return textResultWithError(
      `${GENERATE_IMAGE_TOOL_NAME} generate failed: ${toErrorMessage(error)}. `
      + 'Check the error above: fix the named parameter if one is cited, or retry once without optional overrides '
      + '(model, provider, image_size, resolution).',
      true,
    );
  }
}

async function executeMediaEdit(
  ops: ImageOperations,
  reviewer: ImageVisionReviewer | undefined,
  params: MediaToolParams,
  toolCallId: string,
  referenceResolver?: ImageReferenceResolver,
): Promise<AgentToolResult<MediaToolResultDetails>> {
  const prompt = normalizePrompt(params.prompt);
  if (!prompt) {
    return textResultWithError(
      `Missing required field "prompt" for ${GENERATE_IMAGE_TOOL_NAME} action="edit". `
      + 'Minimal valid JSON: {"action":"edit","prompt":"edit instruction","input_urls":["https://example.test/image.png"]}.',
      true,
    );
  }

  const inputUrls = normalizeInputUrls(params.input_urls);
  if (inputUrls.length === 0) {
    return textResultWithError(
      `Missing required field "input_urls" for ${GENERATE_IMAGE_TOOL_NAME} action="edit"; provide at least one image URL. `
      + 'Minimal valid JSON: {"action":"edit","prompt":"edit instruction","input_urls":["https://example.test/image.png"]}.',
      true,
    );
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
      sourceToolName: GENERATE_IMAGE_TOOL_NAME,
      ...(reference ? { referenceImageIds: [reference.id] } : {}),
    });
    chargePaidImageGeneration(result, 'edit', { toolName: GENERATE_IMAGE_TOOL_NAME, toolCallId });
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
      return contentPolicyBlockedResult<MediaToolResultDetails>(`${GENERATE_IMAGE_TOOL_NAME} edit`, error);
    }
    return textResultWithError(
      `${GENERATE_IMAGE_TOOL_NAME} edit failed: ${toErrorMessage(error)}. `
      + 'Check the error above: fix the named parameter if one is cited, verify every input_urls entry is a '
      + 'reachable image URL, or retry once without optional overrides (model, mask_image_url, image_size).',
      true,
    );
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
    return textResultWithError(
      `Missing required field "input_urls" for ${GENERATE_IMAGE_TOOL_NAME} action="analyze"; provide at least one image URL. `
      + 'Minimal valid JSON: {"action":"analyze","input_urls":["https://example.test/image.png"]}.',
      true,
    );
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
    return textResultWithError(
      `${GENERATE_IMAGE_TOOL_NAME} analyze failed: ${toErrorMessage(error)}. `
      + 'Verify every input_urls entry is a reachable image URL from this conversation before retrying.',
      true,
    );
  }
}

export function createGenerateImageTool(
  ops: ImageOperations,
  reviewer?: ImageVisionReviewer,
  options?: {
    referenceResolver?: ImageReferenceResolver;
  },
): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: GENERATE_IMAGE_TOOL_NAME,
    description:
      'Create or edit an image from a text prompt. Use this when the user asks you to draw, render, or make a picture: '
      + '"draw me a...", "make an image of...", "edit this photo to...". '
      + 'action="generate" requires prompt; action="edit" requires prompt and input_urls; '
      + 'action="analyze" requires input_urls and describes an existing image (optional question). '
      + 'Do NOT use this for images of yourself: selfies, self-portraits, and "what do you look like right now" '
      + 'belong to selfie_create, which keeps your appearance context and saved-reference anchoring active.',
    parameters: Type.Object({
      action: Type.Union(
        MEDIA_ACTION_VALUES.map((value) => Type.Literal(value)),
        {
          description: 'generate = create a new image from prompt; edit = modify the images in input_urls per prompt; analyze = describe the visible contents of input_urls.',
        },
      ),
      prompt: Type.Optional(Type.String({
        description: 'Required for action=generate or action=edit. Full generation prompt or edit instruction.',
      })),
      input_urls: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 4,
        description: 'Required for action=edit or action=analyze. Source image URLs.',
      })),
      question: Type.Optional(Type.String({
        description: 'Optional analysis question. If omitted, the tool returns a concise visible-contents review.',
      })),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.String({
        description: 'Optional model override. Fal models must come from the configured image model catalog; an invalid value returns an error listing the valid models. Omit to use the default model chain.',
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
      toolCallId: string,
      params: MediaToolParams,
    ): Promise<AgentToolResult<MediaToolResultDetails>> => {
      switch (params.action) {
        case 'generate':
          return await executeMediaGenerate(ops, reviewer, params, toolCallId);
        case 'edit':
          return await executeMediaEdit(ops, reviewer, params, toolCallId, options?.referenceResolver);
        case 'analyze':
          return await executeMediaAnalyze(reviewer, params);
        default:
          return textResultWithError(
            `Unsupported ${GENERATE_IMAGE_TOOL_NAME} action: ${String(params.action)}. `
            + 'Valid actions: "generate" (new image), "edit" (modify input_urls), "analyze" (describe input_urls).',
            true,
          );
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
): SubstrateAgentTool {
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
      toolCallId: string,
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
            // prompt on the last configured tier, still anchored to the reference.
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
        chargePaidImageGeneration(result, mode === 'edit' ? 'edit' : 'generate', {
          toolName,
          toolCallId,
        });
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
): SubstrateAgentTool {
  return createImageGenerationTool(ops, reviewer, {
    selfImage: true,
    toolName: 'selfie_create',
    referenceResolver: options?.referenceResolver,
  });
}
