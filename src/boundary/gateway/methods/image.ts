import { randomUUID } from 'node:crypto';
import type { ImageGenerationRpcResult } from '../protocol.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageMode,
} from '../../../primitives/images/types.js';
import {
  ImageService,
  type ImageProviderAttempt,
} from '../../../primitives/images/service.js';
import type { GatewayMethodRuntime, AuditedMethodDescriptor } from './types.js';
import { registerAuditedDescriptors } from './register.js';

type ImageUsageParams = ImageCreateParams | ImageEditParams;

async function recordImageProviderAttempt(
  runtime: GatewayMethodRuntime,
  callKind: 'image_create' | 'image_edit',
  mode: ImageMode,
  params: ImageUsageParams,
  logicalCallId: string,
  providerAttempt: ImageProviderAttempt,
): Promise<void> {
  const recorder = runtime.modelUsageRecorder;
  if (!recorder) return;

  const { result, error } = providerAttempt;
  const sourceToolName = params.sourceToolName?.trim();
  const imageCount = result?.images.length ?? params.numImages ?? 1;
  const inputImageCount = 'imageUrls' in params ? params.imageUrls.length : 0;
  const metadata: Record<string, unknown> = {
    mode,
    promptChars: params.prompt.length,
    imageCount,
    inputImageCount,
    fallbackUsed: result?.fallbackUsed ?? false,
  };
  if (result?.fallbackReason) metadata.fallbackReason = result.fallbackReason;
  if (result?.requestId) metadata.requestId = result.requestId;
  if (params.referenceImageIds?.length) metadata.referenceImageIds = params.referenceImageIds;

  await recorder.recordUsageEvent({
    logicalCallId,
    attempt: providerAttempt.attempt,
    recordedAtMs: providerAttempt.completedAtMs,
    startedAtMs: providerAttempt.startedAtMs,
    completedAtMs: providerAttempt.completedAtMs,
    durationMs: Math.max(0, providerAttempt.completedAtMs - providerAttempt.startedAtMs),
    status: providerAttempt.status,
    settlement: providerAttempt.status === 'success' ? 'complete' : 'unknown',
    callKind,
    callType: 'tool',
    purpose: sourceToolName ?? callKind,
    originType: 'tool',
    originStage: mode,
    service: 'gateway',
    process: sourceToolName ?? mode,
    ...(sourceToolName ? { toolName: sourceToolName } : {}),
    provider: providerAttempt.provider,
    model: providerAttempt.model,
    requestedProvider: params.provider ?? 'auto',
    requestedModel: params.model ?? 'default',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costSource: 'none',
    ...(providerAttempt.status === 'failure' ? {
      errorCode: error?.name ?? 'ImageError',
      errorMessage: error?.message ?? 'Image request failed',
    } : {}),
    metadata,
  });
}

async function runImageWithUsage(
  runtime: GatewayMethodRuntime,
  callKind: 'image_create' | 'image_edit',
  mode: ImageMode,
  params: ImageUsageParams,
): Promise<ImageGenerationRpcResult> {
  if (!runtime.imageConfig) {
    throw new Error('Image provider config is not wired on the gateway');
  }
  const logicalCallId = `image:${randomUUID()}`;
  const imageService = new ImageService(runtime.imageConfig, fetch, {
    personalFilesDir: runtime.workspacePath,
    onProviderAttempt: async providerAttempt => {
      await recordImageProviderAttempt(
        runtime,
        callKind,
        mode,
        params,
        logicalCallId,
        providerAttempt,
      );
    },
  });
  return mode === 'create'
    ? await imageService.create(params as ImageCreateParams)
    : await imageService.edit(params as ImageEditParams);
}

const IMAGE_METHODS: ReadonlyArray<AuditedMethodDescriptor<any, ImageGenerationRpcResult>> = [
  {
    name: 'image.create',
    handler: async (params: ImageCreateParams, runtime: GatewayMethodRuntime) =>
      await runImageWithUsage(
        runtime,
        'image_create',
        'create',
        params,
      ),
    summary: (params: ImageCreateParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      numImages: params.numImages ?? 1,
    }),
  },
  {
    name: 'image.edit',
    handler: async (params: ImageEditParams, runtime: GatewayMethodRuntime) =>
      await runImageWithUsage(
        runtime,
        'image_edit',
        'edit',
        params,
      ),
    summary: (params: ImageEditParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      imageCount: params.imageUrls.length,
    }),
  },
];

export function registerImageMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, IMAGE_METHODS);
}
