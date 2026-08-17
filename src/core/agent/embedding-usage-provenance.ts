import { createHash } from 'node:crypto';
import type {
  EmbeddingProviderCallOptions,
  EmbeddingUsageProvenance,
} from '../../shared/contracts/embedding-provider.js';
import {
  COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  type CorrelationMetadata,
  type ObservabilityCallType,
} from '../../shared/contracts/runtime.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../shared/contracts/runtime-lanes.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';

export type ContentFreeEmbeddingWorkloadNamespace =
  | 'memory-write'
  | 'memory-upsert'
  | 'memory-patch'
  | 'memory-correction'
  | 'memory-import'
  | 'wiki-projection'
  | 'shared-wiki-projection';

export type MemoryEmbeddingOperation = 'write' | 'upsert' | 'patch' | 'correction' | 'import';

export interface EmbeddingOriginIdentifiers {
  requestId?: string;
  turnId?: string;
  sessionId?: string;
}

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

/**
 * Preserve the agent-side workload that initiated an embedding before the call
 * crosses the gateway RPC boundary. An absent request context—or one whose
 * originating runtime did not forward its already-resolved lane—is left absent
 * deliberately. This keeps the sessionless health probe loud and prevents
 * capture from becoming a second, potentially drifting lane resolver.
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
      runtimeLaneClass: correlation.runtimeLaneClass
        ?? RUNTIME_LANE_CLASSES.backgroundContinuation,
      workloadType: 'companion_private_embedding',
      workloadId: 'companion-private:embedding',
    });
  }
  if (!correlation.runtimeLaneClass) return undefined;
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
    runtimeLaneClass: correlation.runtimeLaneClass,
    workloadType,
    workloadId,
  });
}

/**
 * Compose MemoryWriter embedding options at the telemetry boundary. The writer
 * supplies memory-domain identifiers; this module owns request correlation,
 * lane forwarding, and the bounded maintenance fallback.
 */
export function createMemoryEmbeddingCallOptions(
  operation: MemoryEmbeddingOperation,
  origin: EmbeddingOriginIdentifiers | undefined,
  fallbackWorkloadId: string,
): EmbeddingProviderCallOptions {
  const inherited = embeddingUsageProvenanceFromRequestContext(getRequestContext());
  const workloadId = inherited?.workloadId
    ?? origin?.requestId
    ?? origin?.turnId
    ?? origin?.sessionId
    ?? createContentFreeEmbeddingWorkloadId(
      `memory-${operation}`,
      fallbackWorkloadId.trim() || `memory-${operation}`,
    );
  const purpose = `memory.${operation}`;
  return {
    usageProvenance: createEmbeddingUsageProvenance({
      callType: inherited?.callType ?? 'scheduled',
      purpose,
      originType: inherited?.originType ?? 'scheduled',
      originStage: inherited?.originStage ?? purpose,
      service: inherited?.service ?? 'memory',
      process: operation,
      runtimeLaneClass: inherited?.runtimeLaneClass
        ?? RUNTIME_LANE_CLASSES.maintenanceReflection,
      workloadType: inherited?.workloadType ?? 'memory_embedding',
      workloadId,
    }),
  };
}
