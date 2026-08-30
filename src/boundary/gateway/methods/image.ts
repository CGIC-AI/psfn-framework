import { randomUUID } from 'node:crypto';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import {
  GatewayErrors,
  type GatewayCorrelationParams,
  type ImageGenerationRpcResult,
} from '../protocol.js';
import {
  isLocalImageProvider,
  type ImageCreateParams,
  type ImageEditParams,
  type ImageMode,
} from '../../../primitives/images/types.js';
import {
  ImageService,
  type ImageProviderAttempt,
  type ImageProviderAttemptStart,
} from '../../../primitives/images/service.js';
import {
  estimateFalImageRequestCost,
  type FalImageCostEstimate,
} from '../../../primitives/images/fal-cost-estimate.js';
import { resolveInlineOrEnvCredential } from '../../custody/credential-vault.js';
import { roundModelUsageUsd } from '../../../shared/telemetry/model-usage-accounting.js';
import type { GatewayMethodRuntime } from './types.js';
import { defineAuditedMethod } from './types.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';
import {
  COMFYUI_MCP_CREATE_TOOL,
  COMFYUI_MCP_EDIT_TOOL,
  COMFYUI_MCP_SERVER_ID,
  type ComfyUiMcpInvoker,
} from '../../../primitives/images/comfyui-mcp.js';

type ImageUsageParams = (ImageCreateParams | ImageEditParams) & GatewayCorrelationParams;

async function recordImageProviderAttempt(
  runtime: GatewayMethodRuntime,
  callKind: 'image_create' | 'image_edit',
  mode: ImageMode,
  params: ImageUsageParams,
  logicalCallId: string,
  providerAttempt: ImageProviderAttempt,
  falCostEstimate?: FalImageCostEstimate,
): Promise<void> {
  const recorder = runtime.modelUsageRecorder;
  if (!recorder) return;

  const { result, error } = providerAttempt;
  const sourceToolName = params.sourceToolName?.trim();
  const imageCount = result?.images.length ?? params.numImages ?? 1;
  const inputImageCount = 'imageUrls' in params ? params.imageUrls.length : 0;
  const requestedProvider = params.provider
    ?? (params.model ? 'fal' : params.settingsDefaults?.provider)
    ?? 'auto';
  const requestedModel = params.model ?? params.settingsDefaults?.model ?? 'default';
  const costEstimate = providerAttempt.status === 'success' && providerAttempt.provider === 'fal'
    ? falCostEstimate
    : undefined;
  if (providerAttempt.status === 'success' && providerAttempt.provider === 'fal' && !costEstimate) {
    throw new Error('Successful FAL image provider attempt is missing its preflight cost estimate');
  }
  const estimatedCostUsd = costEstimate
    ? roundModelUsageUsd(
        costEstimate.totalUsd * (imageCount / costEstimate.unitQuantity),
      )
    : undefined;
  const localProviderCostUsd = providerAttempt.status === 'success'
    && isLocalImageProvider(providerAttempt.provider)
    ? 0
    : undefined;
  const metadata: Record<string, unknown> = {
    mode,
    promptChars: params.prompt.length,
    imageCount,
    inputImageCount,
    fallbackUsed: result?.fallbackUsed ?? false,
    costAvailability: costEstimate?.source
      ?? (localProviderCostUsd === 0 ? 'local_provider_zero_cost' : 'unknown_provider_not_exposed'),
  };
  if (result?.fallbackReason) metadata.fallbackReason = result.fallbackReason;
  if (result?.requestId) metadata.requestId = result.requestId;
  if (params.referenceImageIds?.length) metadata.referenceImageIds = params.referenceImageIds;
  if (costEstimate) {
    metadata.costEstimateEndpointId = costEstimate.endpointId;
    metadata.costEstimateUnitQuantity = costEstimate.unitQuantity;
  }

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
    attribution: {
      ...(params.companionId ? { companionId: params.companionId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.channelType ? { channelType: params.channelType } : {}),
      callType: params.callType ?? 'tool',
      purpose: params.purpose ?? sourceToolName ?? callKind,
      originType: params.originType ?? 'tool',
      originStage: params.originStage ?? mode,
      service: params.service ?? 'gateway',
      process: params.process ?? sourceToolName ?? mode,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(sourceToolName ? { toolName: sourceToolName } : (params.toolName
        ? { toolName: params.toolName }
        : {})),
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      ...(params.chargeLane ? { chargeLane: params.chargeLane } : {}),
      chargeSurface: providerAttempt.provider === 'fal'
        ? 'paidImageGeneration'
        : 'localImageGeneration',
      ...(params.chargeEventId ? { chargeEventId: params.chargeEventId } : {}),
      ...(params.chargeRunId ? { chargeRunId: params.chargeRunId } : {}),
      ...(params.chargeRootRunId ? { chargeRootRunId: params.chargeRootRunId } : {}),
      ...(params.chargeParentRunId ? { chargeParentRunId: params.chargeParentRunId } : {}),
      ...(params.shardId ? { shardId: params.shardId } : {}),
      ...(params.subagentId ? { subagentId: params.subagentId } : {}),
      ...(params.conversationId ? { conversationId: params.conversationId } : {}),
      ...(params.rootInitiationId ? { rootInitiationId: params.rootInitiationId } : {}),
      ...(params.workloadType ? { workloadType: params.workloadType } : {}),
      ...(params.workloadId ? { workloadId: params.workloadId } : {}),
    },
    provider: providerAttempt.provider,
    model: providerAttempt.model,
    requestedProvider,
    requestedModel,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    ...(costEstimate && estimatedCostUsd !== undefined ? {
      estimatedCostUsd,
      effectiveCostUsd: estimatedCostUsd,
      costSource: 'estimate' as const,
      currency: costEstimate.currency,
    } : localProviderCostUsd === 0 ? {
      providerCostUsd: localProviderCostUsd,
      effectiveCostUsd: localProviderCostUsd,
      costSource: 'provider' as const,
      currency: 'USD',
    } : {
      costSource: 'none' as const,
    }),
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
  const falApiKey = resolveInlineOrEnvCredential(
    runtime.imageConfig.falApiKey,
    runtime.imageConfig.credentialVault,
    'FAL_API_KEY',
  ) ?? '';
  const falCostEstimatesByAttempt = new Map<number, FalImageCostEstimate>();
  const falCostEstimateRequests = new Map<string, Promise<FalImageCostEstimate>>();
  const beforeProviderAttempt = async (providerAttempt: ImageProviderAttemptStart): Promise<void> => {
    if (providerAttempt.provider !== 'fal') return;
    const unitQuantity = params.numImages ?? 1;
    const cacheKey = `${providerAttempt.model}:${String(unitQuantity)}`;
    let request = falCostEstimateRequests.get(cacheKey);
    if (!request) {
      request = estimateFalImageRequestCost({
        apiKey: falApiKey,
        endpointId: providerAttempt.model,
        unitQuantity,
      });
      falCostEstimateRequests.set(cacheKey, request);
    }
    falCostEstimatesByAttempt.set(providerAttempt.attempt, await request);
  };
  const mcpBroker = runtime.mcpBroker;
  const mcpInvoker: ComfyUiMcpInvoker | undefined = mcpBroker
    ? async input => {
        const companionId = runtime.authenticatedCompanionId()?.trim();
        if (!companionId) {
          throw new JSONRPCErrorException(
            'ComfyUI MCP requires an authenticated companion connection',
            GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
          );
        }
        if (runtime.resolveShardWorkloadForChannel?.(params.channelId)) {
          throw new JSONRPCErrorException(
            'ComfyUI MCP denied: shard capability grants exclude external.mcp',
            GatewayErrors.POLICY_DENIED,
            { missingCapability: 'external.mcp' },
          );
        }
        const grantedTokens = runtime.capabilityGrantSnapshotProvider?.().grantedTokens;
        if (!grantedTokens?.includes('external.mcp')) {
          throw new JSONRPCErrorException(
            'ComfyUI MCP denied: authenticated companion lacks external.mcp',
            GatewayErrors.POLICY_DENIED,
            { missingCapability: 'external.mcp' },
          );
        }
        return await mcpBroker.invokeTool({
          companionId,
          serverId: COMFYUI_MCP_SERVER_ID,
          toolName: input.mode === 'create' ? COMFYUI_MCP_CREATE_TOOL : COMFYUI_MCP_EDIT_TOOL,
          arguments: input.arguments,
          outboundSensitivity: 'confidential',
          confirmed: false,
        });
      }
    : undefined;
  const imageService = new ImageService(runtime.imageConfig, fetch, {
    personalFilesDir: runtime.workspacePath,
    beforeProviderAttempt,
    ...(mcpInvoker ? { mcpInvoker } : {}),
    onProviderAttempt: async providerAttempt => {
      await recordImageProviderAttempt(
        runtime,
        callKind,
        mode,
        params as ImageCreateParams & GatewayCorrelationParams,
        logicalCallId,
        providerAttempt,
        falCostEstimatesByAttempt.get(providerAttempt.attempt),
      );
    },
  });
  return mode === 'create'
    ? await imageService.create(params as ImageCreateParams)
    : await imageService.edit(params as ImageEditParams);
}

const IMAGE_METHODS = [
  defineAuditedMethod<ImageCreateParams & GatewayCorrelationParams, ImageGenerationRpcResult>({
    name: 'image.create',
    decode: gatewayMethodParamDecoders['image.create'],
    handler: async (params: ImageCreateParams & GatewayCorrelationParams, runtime: GatewayMethodRuntime) =>
      await runImageWithUsage(
        runtime,
        'image_create',
        'create',
        params as ImageEditParams & GatewayCorrelationParams,
      ),
    summary: (params: ImageCreateParams & GatewayCorrelationParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      numImages: params.numImages ?? 1,
    }),
  }),
  defineAuditedMethod<ImageEditParams & GatewayCorrelationParams, ImageGenerationRpcResult>({
    name: 'image.edit',
    decode: gatewayMethodParamDecoders['image.edit'],
    handler: async (params: ImageEditParams & GatewayCorrelationParams, runtime: GatewayMethodRuntime) =>
      await runImageWithUsage(
        runtime,
        'image_edit',
        'edit',
        params,
      ),
    summary: (params: ImageEditParams & GatewayCorrelationParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      imageCount: params.imageUrls.length,
    }),
  }),
];

export function registerImageMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, IMAGE_METHODS);
}
