import type {
  AuditedMethodDescriptor,
  GatewayMethodRuntime,
  GatedMethodDescriptor,
} from './types.js';

/**
 * 2h6q.3: read the runtime-stamped correlation channel id off gated dispatch
 * params. It is only a lookup key into the server-owned shard workload
 * registry — never authority — and absent/malformed values simply resolve as
 * "not shard-recognizable" (the registry resolver still fails closed for
 * recognizable shard channels).
 */
function readCorrelationChannelId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const value = (params as { channelId?: unknown }).channelId;
  return typeof value === 'string' ? value : undefined;
}

export function registerAuditedDescriptors(
  runtime: GatewayMethodRuntime,
  descriptors: ReadonlyArray<AuditedMethodDescriptor>,
): void {
  for (const descriptor of descriptors) {
    runtime.target.addMethod(
      descriptor.name,
      runtime.audited(
        descriptor.name,
        (params: unknown) => descriptor.handler(params, runtime),
        descriptor.summary,
      ),
    );
  }
}

export function registerGatedDescriptors(
  runtime: GatewayMethodRuntime,
  descriptors: ReadonlyArray<GatedMethodDescriptor>,
): void {
  const approvalBoundary = (runtime as Partial<GatewayMethodRuntime>).approvalBoundary;
  if (!approvalBoundary || typeof approvalBoundary.gate !== 'function') {
    throw new Error('Gateway method runtime is missing approvalBoundary.gate');
  }
  const gateMethod = (input: {
      method: string;
      handler: (params: unknown) => Promise<unknown>;
      prepareParams: (params: unknown) => unknown;
      paramsSummary: (params: unknown) => Record<string, unknown>;
      authenticatedCompanionId: () => string | undefined;
      approvalAction: string;
      approvalScope: (params: unknown) => string;
      approvalReason?: (params: unknown) => string;
      prePolicyGuard?: (params: unknown) => void;
      policyConfigProvider?: () => GatewayMethodRuntime['policyConfig'];
    }): ((params: unknown) => Promise<unknown>) => {
    const resolveShardWorkloadForChannel = runtime.resolveShardWorkloadForChannel;
    return approvalBoundary.gate({
      method: input.method,
      handler: input.handler,
      prepareParams: input.prepareParams,
      paramsSummary: input.paramsSummary,
      authenticatedCompanionId: input.authenticatedCompanionId,
      approvalAction: input.approvalAction,
      approvalScope: input.approvalScope,
      ...(input.approvalReason ? { approvalReason: input.approvalReason } : {}),
      ...(input.prePolicyGuard ? { prePolicyGuard: input.prePolicyGuard } : {}),
      ...(input.policyConfigProvider ? { policyConfigProvider: input.policyConfigProvider } : {}),
      // 2h6q.3: bind authenticated shard lineage per dispatch from the
      // server-owned workload registry (never from tool params/client fields;
      // the correlation channel id is only a lookup key).
      ...(resolveShardWorkloadForChannel
        ? {
          shardApprovalGrant: (params: unknown) =>
            resolveShardWorkloadForChannel(readCorrelationChannelId(params)),
        }
        : {}),
    });
  };

  for (const descriptor of descriptors) {
    runtime.target.addMethod(
      descriptor.name,
      gateMethod({
        method: descriptor.name,
        handler: (params: unknown) => descriptor.handler(params, runtime),
        prepareParams: descriptor.decode,
        paramsSummary: descriptor.summary,
        authenticatedCompanionId: runtime.authenticatedCompanionId,
        approvalAction: descriptor.approvalAction,
        approvalScope: descriptor.approvalScope,
        approvalReason: descriptor.approvalReason,
        ...(descriptor.prePolicyGuard
          ? { prePolicyGuard: (params: unknown) => descriptor.prePolicyGuard!(params, runtime) }
          : {}),
        policyConfigProvider: () => runtime.policyConfig,
      }),
    );
  }
}
