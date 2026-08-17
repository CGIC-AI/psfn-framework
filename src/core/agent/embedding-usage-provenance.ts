import { createHash } from 'node:crypto';
import type { EmbeddingUsageProvenance } from '../../shared/contracts/embedding-provider.js';
import {
  COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  type CorrelationMetadata,
  type ObservabilityCallType,
} from '../../shared/contracts/runtime.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../shared/contracts/runtime-lanes.js';
import {
  resolveRuntimeLaneClassForModelCall,
  type ModelCallRuntimePurpose,
} from './worker-lanes.js';

export type ContentFreeEmbeddingWorkloadNamespace =
  | 'memory-write'
  | 'memory-upsert'
  | 'memory-patch'
  | 'memory-correction'
  | 'memory-import'
  | 'wiki-projection'
  | 'shared-wiki-projection';

export interface CreateEmbeddingUsageProvenanceInput {
  callType: ObservabilityCallType;
  purpose: string;
  originType?: ObservabilityCallType;
  originStage?: string;
  service: string;
  process: string;
  runtimeLaneClass: RuntimeLaneClass;
  workloadType: string;
  workloadId: string;
}

export type CreateMaintenanceEmbeddingUsageProvenanceInput = Omit<
  CreateEmbeddingUsageProvenanceInput,
  'callType' | 'originType' | 'originStage' | 'runtimeLaneClass'
>;

export function createEmbeddingUsageProvenance(
  input: CreateEmbeddingUsageProvenanceInput,
): EmbeddingUsageProvenance {
  return {
    callType: input.callType,
    purpose: input.purpose,
    originType: input.originType ?? input.callType,
    originStage: input.originStage ?? input.purpose,
    service: input.service,
    process: input.process,
    runtimeLaneClass: input.runtimeLaneClass,
    workloadType: input.workloadType,
    workloadId: input.workloadId,
  };
}

export function createMaintenanceEmbeddingUsageProvenance(
  input: CreateMaintenanceEmbeddingUsageProvenanceInput,
): EmbeddingUsageProvenance {
  return createEmbeddingUsageProvenance({
    ...input,
    callType: 'scheduled',
    runtimeLaneClass: RUNTIME_LANE_CLASSES.maintenanceReflection,
  });
}

/**
 * Usage dimensions must never retain source paths, URLs, titles, or content.
 * Keep the operational namespace visible while reducing the source identity to
 * a fixed-width digest suitable only for grouping the same maintenance work.
 */
export function createContentFreeEmbeddingWorkloadId(
  namespace: ContentFreeEmbeddingWorkloadNamespace,
  sourceIdentity: string,
): string {
  if (sourceIdentity.length === 0) {
    throw new Error('Embedding workload source identity must not be empty');
  }
  const digest = createHash('sha256').update(namespace).update('\0').update(sourceIdentity).digest('hex');
  return `${namespace}:${digest}`;
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function runtimePurposeForEmbedding(callType: ObservabilityCallType): ModelCallRuntimePurpose {
  if (callType === 'chat' || callType === 'tool') return 'chat';
  if (callType === 'summary') return 'summary';
  if (callType === 'background') return 'background';
  return 'memory';
}

/**
 * Preserve the agent-side workload that initiated an embedding before the call
 * crosses the gateway RPC boundary. An entirely absent request context is left
 * absent deliberately: the sessionless health probe remains the loud unknown
 * sentinel instead of being mislabeled as product work.
 */
export function embeddingUsageProvenanceFromRequestContext(
  correlation: Partial<CorrelationMetadata> | undefined,
): EmbeddingUsageProvenance | undefined {
  if (!correlation) return undefined;
  if (correlation.telemetryVisibility === 'companion_private') {
    return createEmbeddingUsageProvenance({
      callType: 'background',
      purpose: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
      service: 'companion-private',
      process: 'embedding',
      runtimeLaneClass: RUNTIME_LANE_CLASSES.backgroundContinuation,
      workloadType: 'companion_private_embedding',
      workloadId: 'companion-private:embedding',
    });
  }
  const callType = correlation.callType ?? 'memory';
  const purpose = normalized(correlation.purpose) ?? 'embedding';
  const originStage = normalized(correlation.originStage) ?? purpose;
  const service = normalized(correlation.service) ?? 'memory';
  const process = normalized(correlation.process) ?? originStage;
  const workloadType = normalized(correlation.workloadType) ?? `${callType}_embedding`;
  const workloadId = (
    normalized(correlation.workloadId)
    ?? normalized(correlation.requestId)
    ?? normalized(correlation.turnId)
    ?? normalized(correlation.sessionId)
    ?? normalized(correlation.channelId)
    ?? `${service}:${process}`
  );
  return createEmbeddingUsageProvenance({
    callType,
    purpose,
    originType: correlation.originType ?? callType,
    originStage,
    service,
    process,
    runtimeLaneClass: resolveRuntimeLaneClassForModelCall({
      purpose: runtimePurposeForEmbedding(callType),
      callType,
      ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
      originStage,
    }),
    workloadType,
    workloadId,
  });
}
