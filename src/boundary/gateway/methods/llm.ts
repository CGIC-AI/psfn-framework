import { randomUUID } from 'node:crypto';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors } from '../protocol.js';
import type {
  LLMChatParams,
  LLMCompleteParams,
  LLMDiscoverModelsParams,
  LLMDiscoverModelsResult,
  LLMEmbedParams,
  LLMInvalidateModelDiscoveryParams,
  LLMInvalidateModelDiscoveryResult,
  LLMChunkNotification,
  LLMFirstOutputNotification,
  GatewayCorrelationParams,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import type {
  ContextMessage,
  CorrelationMetadata,
  CompletionPurpose,
  LLMModelHint,
  LLMUsageDetails,
  ObservabilityCallType,
} from '../../../shared/contracts/runtime.js';
import { registerAuditedDescriptors } from './register.js';
import {
  inferCallType as inferCorrelationCallType,
  resolveCorrelationMetadata,
} from '../../../primitives/llm/correlation.js';
import {
  applyGatewayCapturedProviderCost,
  withGatewayLLMCostCapture,
} from '../llm-cost-capture.js';
import {
  GatewayInlineImageRetentionMissError,
  resolveGatewayInlineImageReferences,
} from '../inline-image-retention.js';
import { normalizeLLMCallAccountingContext } from '../../../primitives/llm/accounting-context.js';
import {
  parseWorkSpecWireParams,
  type LLMWorkSpecWireParams,
} from '../../../primitives/llm/work-spec-wire.js';
import { extractProviderAttemptUsageDetails } from '../../../shared/telemetry/provider-attempt-error.js';
import { hasProviderCostEvidenceConflict } from '../../../shared/telemetry/provider-cost-evidence.js';
import { ModelBudgetExceededError } from '../../../primitives/llm/model-budget.js';
import { IcpConversationCostBreakerError } from '../../../primitives/llm/icp-conversation-cost-breaker.js';
import {
  ModelCallPreemptedError,
  toModelCallPreemptedErrorData,
} from '../../../primitives/llm/model-call-gate.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('GatewayLLM');

/**
 * Re-raise gateway-side model-call gate/budget outcomes as typed JSON-RPC
 * errors so their identity survives serialization to the agent. Applied to both
 * the `llm.chat` (stream) and `llm.complete` handlers. Without the
 * ModelCallPreemptedError branch, json-rpc-2.0 flattens a preemption to a
 * generic -32603 (name lost) and the agent charges it as a provider failure,
 * eventually exhausting retries and losing the background cognition job.
 */
export async function exposeModelCallGateBlocks<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ModelBudgetExceededError) {
      throw new JSONRPCErrorException(
        error.message,
        GatewayErrors.MODEL_BUDGET_BLOCKED,
        error.event,
      );
    }
    if (error instanceof IcpConversationCostBreakerError) {
      throw new JSONRPCErrorException(
        error.message,
        GatewayErrors.ICP_CONVERSATION_COST_BLOCKED,
        error.event,
      );
    }
    if (error instanceof ModelCallPreemptedError) {
      throw new JSONRPCErrorException(
        error.message,
        GatewayErrors.MODEL_CALL_PREEMPTED,
        toModelCallPreemptedErrorData(error),
      );
    }
    throw error;
  }
}

/**
 * psfn-framework-d8vq.2: parse an RPC-transported LLMWorkSpec fail-closed at the
 * boundary. A malformed spec is rejected as a typed JSON-RPC error BEFORE any
 * provider I/O; an absent spec is simply undefined (legacy non-work-spec calls
 * are untouched). The parsed spec is forwarded to the serving-side LLMClient so
 * its accountability guard + lane reconciliation fire in the split topology.
 *
 * psfn-framework-fxt1: additionally re-verify a caller-asserted
 * `preemptionProtected` against the welfare-grant authority (the background-work
 * store) and STRIP it on any failure before the gate can honor it.
 */
export async function resolveRpcWorkSpec(
  raw: unknown,
  runtime: GatewayMethodRuntime,
): Promise<LLMWorkSpecWireParams | undefined> {
  if (raw === undefined || raw === null) return undefined;
  let spec: LLMWorkSpecWireParams;
  try {
    spec = parseWorkSpecWireParams(raw);
  } catch (error) {
    throw new JSONRPCErrorException(
      error instanceof Error ? error.message : 'Malformed LLMWorkSpec',
      GatewayErrors.INVALID_WORK_SPEC,
    );
  }
  return await enforceWelfareGrant(spec, runtime);
}

/**
 * psfn-framework-fxt1: honor `preemptionProtected` only when its welfare grant
 * verifies; strip it (and always the gateway-only `welfareGrantJobId` token)
 * otherwise. Fail closed: absent verifier, absent/invalid grant id, non-welfare
 * or non-running row, wrong companion, or a verify throw all resolve to a
 * preemptable (unprotected) spec — no path forwards an unverified `true`.
 */
async function enforceWelfareGrant(
  spec: LLMWorkSpecWireParams,
  runtime: GatewayMethodRuntime,
): Promise<LLMWorkSpecWireParams> {
  // `welfareGrantJobId` is a gateway-only verification token — never forward it
  // past the boundary regardless of the outcome.
  const { welfareGrantJobId, ...forwarded } = spec;
  if (spec.preemptionProtected !== true) {
    return forwarded;
  }
  if (await verifyPreemptionGrant(spec.welfareGrantJobId, runtime)) {
    return forwarded;
  }
  const { preemptionProtected: _stripped, ...unprotected } = forwarded;
  return unprotected;
}

async function verifyPreemptionGrant(
  welfareGrantJobId: string | undefined,
  runtime: GatewayMethodRuntime,
): Promise<boolean> {
  const companionId = runtime.authenticatedCompanionId();
  if (!welfareGrantJobId || !companionId || !runtime.verifyWelfareGrant) {
    // Version skew (old agent sends no grant id), an unauthenticated call, or a
    // gateway with no verifier: cannot prove the escalation → strip. This is the
    // benign anti-starvation-lost degradation, not an error.
    log.debug('preemptionProtected asserted without a verifiable welfare grant; stripping', {
      hasGrantId: Boolean(welfareGrantJobId),
      hasCompanion: Boolean(companionId),
      hasVerifier: Boolean(runtime.verifyWelfareGrant),
    });
    return false;
  }
  try {
    return await runtime.verifyWelfareGrant(welfareGrantJobId, companionId);
  } catch (error) {
    // No swallowed errors: a verify/DB failure is surfaced to telemetry, then
    // the call proceeds preemptable (fail closed). The exception never
    // propagates to the provider path.
    log.warn('Welfare grant verification failed; stripping preemptionProtected (fail closed)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function authorizeIcpCorrelation<P extends GatewayCorrelationParams>(
  params: P,
  runtime: GatewayMethodRuntime,
): Promise<P> {
  if (!params.icpCorrelation) return params;
  if (!runtime.authorizeIcpConversationCorrelation) {
    throw new JSONRPCErrorException(
      'ICP conversation cost correlation authorization is unavailable',
      GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
    );
  }
  return {
    ...params,
    icpCorrelation: await runtime.authorizeIcpConversationCorrelation(params.icpCorrelation),
  };
}

const llmDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'llm.chat',
    handler: async (params: LLMChatParams, runtime) => {
      params = await authorizeIcpCorrelation(params, runtime);
      const workSpec = await resolveRpcWorkSpec(params.workSpec, runtime);
      const messages = resolveRetainedImageReferences(params, runtime);
      const shardRouting = resolveShardChannelRouting(params.channelId);
      const requestId = params.requestId ?? runtime.nextStreamRequestId();
      const callType = params.callType ?? (shardRouting ? 'tool' : 'chat');
      const purpose = normalizePurpose(params.purpose) ?? (shardRouting ? 'shard.execution' : 'chat');
      const modelHint = extractModelHintFromParams(params);
      const accounting = normalizeLLMCallAccountingContext(params.accounting);
      const correlation = buildCorrelation({
        ...params,
        turnId: params.turnId,
        requestId,
        channelId: params.channelId,
        callType,
        originType: params.originType,
        originStage: params.originStage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        purpose,
        telemetryVisibility: params.telemetryVisibility,
      });
      const captured = await withGatewayLLMCostCapture(
        async () => await exposeModelCallGateBlocks(async () => await runtime.llmProvider.stream(
          {
            systemPrompt: params.systemPrompt,
            messages,
            ...(params.tools?.length ? { tools: params.tools } : {}),
            ...(params.promptCacheBoundaries ? { promptCacheBoundaries: params.promptCacheBoundaries } : {}),
            ...(modelHint ? { modelHint } : {}),
            ...(accounting ? { accounting } : {}),
            correlation,
          },
          params.stream ? {
            onText: (text) => {
              runtime.notifyRequester('llm.chunk', { requestId, text } satisfies LLMChunkNotification);
            },
            onFirstOutput: (observation) => {
              runtime.notifyRequester('llm.first_output', {
                requestId,
                ...observation,
              } satisfies LLMFirstOutputNotification);
            },
          } : undefined,
          // psfn-framework-d8vq.2: forward the parsed work spec so the
          // gateway-side LLMClient enforces the accountability guard + lane
          // reconciliation for an autonomous streamed call. undefined when
          // absent so the interactive chat path is unchanged.
          workSpec ? { workSpec } : undefined,
        )),
      );
      const response = applyGatewayCapturedProviderCost(
        captured.result,
        captured.finalAttemptProviderCostEvidence,
      );
      return {
        content: response.content,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.providerObservability ? { providerObservability: response.providerObservability } : {}),
        toolCalls: response.toolCalls,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.usageDetails ? { usageDetails: response.usageDetails } : {}),
        stopReason: response.stopReason,
        requestId,
      };
    },
    summary: (p: LLMChatParams) => ({
      ...toShardRoutingSummary(resolveShardChannelRouting(p.channelId)),
      ...(p.companionId?.trim() ? { companionId: p.companionId.trim() } : {}),
      model: p.model,
      stream: p.stream,
      ...toSummaryCorrelation(buildCorrelation({
        ...p,
        turnId: p.turnId,
        requestId: p.requestId,
        channelId: p.channelId,
        callType: p.callType ?? (resolveShardChannelRouting(p.channelId) ? 'tool' : 'chat'),
        originType: p.originType,
        originStage: p.originStage,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        purpose: normalizePurpose(p.purpose) ?? (resolveShardChannelRouting(p.channelId) ? 'shard.execution' : 'chat'),
        telemetryVisibility: p.telemetryVisibility,
      })),
    }),
  },
  {
    name: 'llm.complete',
    handler: async (params: LLMCompleteParams, runtime) => {
      params = await authorizeIcpCorrelation(params, runtime);
      const workSpec = await resolveRpcWorkSpec(params.workSpec, runtime);
      const messages = resolveRetainedImageReferences(params, runtime);
      const shardRouting = resolveShardChannelRouting(params.channelId);
      const inferredCallType = inferCallType(params.purpose, params.channelId);
      const modelHint = extractModelHintFromParams(params);
      const accounting = normalizeLLMCallAccountingContext(params.accounting);
      const correlation = buildCorrelation({
        ...params,
        turnId: params.turnId,
        requestId: params.requestId ?? params.turnId,
        channelId: params.channelId,
        callType: params.callType ?? (shardRouting && inferredCallType === 'chat'
          ? 'tool'
          : inferredCallType),
        originType: params.originType,
        originStage: params.originStage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        purpose: params.purpose,
        telemetryVisibility: params.telemetryVisibility,
      });
      const captured = await withGatewayLLMCostCapture(
        async () => await exposeModelCallGateBlocks(async () => await runtime.llmProvider.complete(
          {
            systemPrompt: params.systemPrompt,
            messages,
            ...(params.promptCacheBoundaries ? { promptCacheBoundaries: params.promptCacheBoundaries } : {}),
            ...(modelHint ? { modelHint } : {}),
            ...(accounting ? { accounting } : {}),
            correlation,
          },
          params.purpose,
          // psfn-framework-d8vq.2: forward the parsed work spec so the
          // gateway-side LLMClient enforces the fail-closed accountability guard
          // + lane reconciliation for an autonomous completion. undefined when
          // absent so legacy non-work-spec calls are unchanged.
          workSpec ? { workSpec } : undefined,
        )),
      );
      const response = applyGatewayCapturedProviderCost(
        captured.result,
        captured.finalAttemptProviderCostEvidence,
      );
      return {
        content: response.content,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.providerObservability ? { providerObservability: response.providerObservability } : {}),
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.usageDetails ? { usageDetails: response.usageDetails } : {}),
        stopReason: response.stopReason,
      };
    },
    summary: (p: LLMCompleteParams) => ({
      ...toShardRoutingSummary(resolveShardChannelRouting(p.channelId)),
      ...(p.companionId?.trim() ? { companionId: p.companionId.trim() } : {}),
      purpose: p.purpose,
      ...toSummaryCorrelation(buildCorrelation({
        ...p,
        turnId: p.turnId,
        requestId: p.requestId ?? p.turnId,
        channelId: p.channelId,
        callType: p.callType ?? (() => {
          const shardRouting = resolveShardChannelRouting(p.channelId);
          const inferred = inferCallType(p.purpose, p.channelId);
          if (shardRouting && inferred === 'chat') return 'tool';
          return inferred;
        })(),
        originType: p.originType,
        originStage: p.originStage,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        purpose: p.purpose,
        telemetryVisibility: p.telemetryVisibility,
      })),
    }),
  },
  {
    name: 'llm.embed',
    handler: async (params: LLMEmbedParams, runtime) => {
      const startedAtMs = Date.now();
      const logicalCallId = `embedding:${randomUUID()}`;
      const recordsUsageInternally = embeddingRecordsUsageInternally(runtime);
      const correlation = buildCorrelation({
        ...params,
        callType: params.callType ?? 'memory',
        purpose: params.purpose ?? 'embedding',
        originType: params.originType ?? 'memory',
        originStage: params.originStage ?? 'embedding',
      });
      let result: EmbeddingBatchProviderUsageResult;
      try {
        result = await runWithRequestContext(
          correlation,
          async () => await embedBatchWithProviderUsage(runtime, params.texts),
        );
      } catch (error) {
        if (!recordsUsageInternally) {
          await recordEmbeddingUsage(
            runtime,
            params,
            logicalCallId,
            startedAtMs,
            'failure',
            extractProviderAttemptUsageDetails(error),
            error,
          );
        }
        throw error;
      }
      if (!recordsUsageInternally) {
        await recordEmbeddingUsage(
          runtime,
          params,
          logicalCallId,
          startedAtMs,
          'success',
          result.usageDetails,
        );
      }
      return { embeddings: result.embeddings.map(e => Array.from(e)) };
    },
    summary: (p: LLMEmbedParams) => ({ textCount: p.texts.length }),
  },
  {
    name: 'llm.discover_models',
    handler: async (_params: LLMDiscoverModelsParams, runtime): Promise<LLMDiscoverModelsResult> => {
      const discovery = requireModelDiscovery(runtime);
      return {
        models: await discovery.getAvailableModels(),
      };
    },
  },
  {
    name: 'llm.invalidate_model_discovery',
    handler: async (
      _params: LLMInvalidateModelDiscoveryParams,
      runtime,
    ): Promise<LLMInvalidateModelDiscoveryResult> => {
      const discovery = requireModelDiscovery(runtime);
      discovery.invalidateCache();
      return { success: true };
    },
  },
];

export function registerLLMMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, llmDescriptors);
}

function resolveRetainedImageReferences(
  params: LLMChatParams | LLMCompleteParams,
  runtime: GatewayMethodRuntime,
): ContextMessage[] {
  try {
    const resolved = resolveGatewayInlineImageReferences(
      params.messages,
      runtime.inlineImageRetention,
      params.turnId,
    );
    // The gateway wire admits structured provider blocks while the legacy
    // LLMContext contract still types `content` as text-only.
    return resolved as unknown as ContextMessage[];
  } catch (error) {
    if (error instanceof GatewayInlineImageRetentionMissError) {
      throw new JSONRPCErrorException(error.message, GatewayErrors.INLINE_IMAGE_RETENTION_MISS);
    }
    throw error;
  }
}

function requireModelDiscovery(
  runtime: GatewayMethodRuntime,
): NonNullable<GatewayMethodRuntime['modelDiscovery']> {
  if (!runtime.modelDiscovery) {
    throw new Error('Gateway model discovery is unavailable.');
  }
  return runtime.modelDiscovery;
}

function buildCorrelation(params: GatewayCorrelationParams & {
  callType: ObservabilityCallType;
  purpose: string;
  telemetryVisibility?: CorrelationMetadata['telemetryVisibility'];
}): CorrelationMetadata {
  return resolveCorrelationMetadata(
    {
      ...params,
      callType: params.callType,
      purpose: params.purpose,
      ...(params.telemetryVisibility ? { telemetryVisibility: params.telemetryVisibility } : {}),
    },
    undefined,
    params.purpose === 'chat' ? 'chat' : 'background',
  );
}

function inferCallType(
  purpose: CompletionPurpose,
  channelId: string | undefined,
): ObservabilityCallType {
  return inferCorrelationCallType(purpose, channelId);
}

interface EmbeddingBatchProviderUsageResult {
  embeddings: Float32Array[];
  usageDetails?: LLMUsageDetails;
}

function embeddingRecordsUsageInternally(runtime: GatewayMethodRuntime): boolean {
  return (runtime.embeddingService as { recordsModelUsageInternally?: unknown })
    .recordsModelUsageInternally === true;
}

async function embedBatchWithProviderUsage(
  runtime: GatewayMethodRuntime,
  texts: string[],
): Promise<EmbeddingBatchProviderUsageResult> {
  const provider = runtime.embeddingService as GatewayMethodRuntime['embeddingService'] & {
    embedBatchWithUsage?: (input: string[]) => Promise<EmbeddingBatchProviderUsageResult>;
  };
  if (provider.embedBatchWithUsage) {
    return await provider.embedBatchWithUsage(texts);
  }
  return { embeddings: await provider.embedBatch(texts) };
}

async function recordEmbeddingUsage(
  runtime: GatewayMethodRuntime,
  params: LLMEmbedParams,
  logicalCallId: string,
  startedAtMs: number,
  status: 'success' | 'failure',
  usageDetails?: LLMUsageDetails,
  error?: unknown,
): Promise<void> {
  const recorder = runtime.modelUsageRecorder;
  if (!recorder) return;
  const completedAtMs = Date.now();
  const embeddingMetadata = runtime.embeddingService as unknown as { kind?: unknown; model?: unknown };
  const provider = typeof embeddingMetadata.kind === 'string'
    ? embeddingMetadata.kind
    : 'embedding';
  const model = typeof embeddingMetadata.model === 'string'
    ? embeddingMetadata.model
    : `dims:${runtime.embeddingService.dims}`;
  await recorder.recordUsageEvent({
    logicalCallId,
    attempt: 1,
    recordedAtMs: completedAtMs,
    startedAtMs,
    completedAtMs,
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    status,
    settlement: usageDetails
      ? (hasProviderCostEvidenceConflict(usageDetails.raw) ? 'partial' : 'complete')
      : 'unknown',
    callKind: 'embedding',
    attribution: {
      ...(params.companionId ? { companionId: params.companionId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.channelType ? { channelType: params.channelType } : {}),
      callType: params.callType ?? 'memory',
      purpose: params.purpose ?? 'embedding',
      originType: params.originType ?? 'memory',
      originStage: params.originStage ?? 'embedding',
      service: params.service ?? 'memory',
      process: params.process ?? 'embedding',
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(params.toolName ? { toolName: params.toolName } : {}),
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      ...(params.chargeLane ? { chargeLane: params.chargeLane } : {}),
      ...(params.chargeSurface ? { chargeSurface: params.chargeSurface } : {}),
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
    provider,
    model,
    requestedProvider: provider,
    requestedModel: model,
    inputTokens: usageDetails?.input ?? 0,
    outputTokens: usageDetails?.output ?? 0,
    cacheReadTokens: usageDetails?.cacheRead ?? 0,
    cacheWriteTokens: usageDetails?.cacheWrite ?? 0,
    totalTokens: usageDetails?.totalTokens ?? 0,
    ...(usageDetails?.cost ? { providerCost: usageDetails.cost } : {}),
    ...(error
      ? {
          errorCode: error instanceof Error ? error.name : 'EmbeddingError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }
      : {}),
    metadata: {
      textCount: params.texts.length,
      totalInputChars: params.texts.reduce((total, text) => total + text.length, 0),
      dims: runtime.embeddingService.dims,
      ...(usageDetails?.raw ? { rawUsage: usageDetails.raw } : {}),
    },
  });
}

function toSummaryCorrelation(
  correlation: CorrelationMetadata,
): Record<string, unknown> {
  return {
    ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
    callType: correlation.callType,
    ...(correlation.originType ? { originType: correlation.originType } : {}),
    ...(correlation.originStage ? { originStage: correlation.originStage } : {}),
    ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
    ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    purpose: correlation.purpose,
  };
}

function resolveShardChannelRouting(
  channelId: string | undefined,
): { shardId: string } | null {
  const normalized = channelId?.trim();
  if (!normalized || !normalized.startsWith('shard:')) {
    return null;
  }

  const shardId = normalized.slice('shard:'.length).trim();
  if (!shardId) {
    throw new Error('Shard channel routing requires a non-empty shard identifier.');
  }
  return { shardId };
}

function toShardRoutingSummary(
  shardRouting: { shardId: string } | null,
): Record<string, string> {
  if (!shardRouting) {
    return {};
  }
  return {
    routingTarget: 'shard',
    shardId: shardRouting.shardId,
  };
}

function normalizePurpose(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractModelHintFromParams(
  params: LLMChatParams | LLMCompleteParams,
): LLMModelHint | undefined {
  const model = normalizePurpose(params.model);
  const provider = normalizePurpose(params.provider)?.toLowerCase();
  const pin = typeof params.pin === 'boolean' ? params.pin : undefined;
  const maxTokens = toPositiveInteger(params.maxTokens);
  const contextWindow = toPositiveInteger(params.contextWindow);
  const thinkingEnabled = typeof params.thinkingEnabled === 'boolean'
    ? params.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(params.thinkingEffort);
  const temperature = toFiniteNumber(params.temperature);
  const topP = toUnitInterval(params.topP);
  const topK = toPositiveInteger(params.topK);
  const frequencyPenalty = toFiniteNumber(params.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(params.repetitionPenalty);
  if (
    !model
    && !provider
    && pin === undefined
    && maxTokens === undefined
    && contextWindow === undefined
    && thinkingEnabled === undefined
    && thinkingEffort === undefined
    && temperature === undefined
    && topP === undefined
    && topK === undefined
    && frequencyPenalty === undefined
    && repetitionPenalty === undefined
  ) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(pin !== undefined ? { pin } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): LLMModelHint['thinkingEffort'] | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}
