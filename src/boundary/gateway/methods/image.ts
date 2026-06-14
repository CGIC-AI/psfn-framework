import type { ImageGenerationRpcResult } from '../protocol.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageMode,
} from '../../../primitives/images/types.js';
import { ImageService } from '../../../primitives/images/service.js';
import type { GatewayMethodRuntime, AuditedMethodDescriptor } from './types.js';
import { registerAuditedDescriptors } from './register.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('GatewayImageMethods');

function requireImageService(runtime: GatewayMethodRuntime): ImageService {
  if (!runtime.imageConfig) {
    throw new Error('Image provider config is not wired on the gateway');
  }
  return new ImageService(runtime.imageConfig, fetch, {
    personalFilesDir: runtime.workspacePath,
  });
}

function createImageUsageLogicalCallId(result: ImageGenerationResult | undefined): string {
  if (result?.requestId) {
    return `image:${result.requestId}`;
  }
  return `image:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

type ImageUsageParams = ImageCreateParams | ImageEditParams;

function recordImageUsage(
  runtime: GatewayMethodRuntime,
  callKind: 'image_create' | 'image_edit',
  mode: ImageMode,
  params: ImageUsageParams,
  startedAtMs: number,
  status: 'success' | 'failure',
  result?: ImageGenerationResult,
  error?: unknown,
): void {
  const recorder = runtime.modelUsageRecorder;
  if (!recorder) return;

  const completedAtMs = Date.now();
  const sourceToolName = params.sourceToolName?.trim();
  const provider = result?.provider ?? (params.provider === 'auto' ? undefined : params.provider);
  const model = result?.model ?? params.model;
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

  recorder.recordUsageEvent({
    logicalCallId: createImageUsageLogicalCallId(result),
    attempt: 0,
    recordedAtMs: completedAtMs,
    startedAtMs,
    completedAtMs,
    durationMs: completedAtMs - startedAtMs,
    status,
    callKind,
    callType: 'tool',
    purpose: sourceToolName ?? callKind,
    originType: 'tool',
    originStage: mode,
    service: 'gateway',
    process: sourceToolName ?? mode,
    ...(sourceToolName ? { toolName: sourceToolName } : {}),
    provider: provider ?? 'unknown',
    model: model ?? 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costSource: 'none',
    ...(status === 'failure' ? {
      errorCode: error instanceof Error ? error.name : 'ImageError',
      errorMessage: error instanceof Error ? error.message : String(error ?? 'Image request failed'),
    } : {}),
    metadata,
  }).catch(recordError => {
    log.warn('Failed to record image model usage', {
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
  });
}

async function runImageWithUsage(
  runtime: GatewayMethodRuntime,
  callKind: 'image_create' | 'image_edit',
  mode: ImageMode,
  params: ImageUsageParams,
  operation: () => Promise<ImageGenerationRpcResult>,
): Promise<ImageGenerationRpcResult> {
  const startedAtMs = Date.now();
  try {
    const result = await operation();
    recordImageUsage(runtime, callKind, mode, params, startedAtMs, 'success', result);
    return result;
  } catch (error) {
    recordImageUsage(runtime, callKind, mode, params, startedAtMs, 'failure', undefined, error);
    throw error;
  }
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
        () => requireImageService(runtime).create(params),
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
        () => requireImageService(runtime).edit(params),
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
