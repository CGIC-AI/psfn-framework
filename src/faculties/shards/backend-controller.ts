import type { CapabilityTier } from '../types.js';
import type { GatewayClient } from '../gateway/client.js';
import type {
  ShardBackend,
  ShardConfig,
  ShardSourceContext,
} from './types.js';
import type {
  ShardBackendRequestParams,
  ShardBackendRequestResult,
} from '../gateway/protocol.js';
import { normalizeCapabilityTier } from '../capabilities/tiers.js';

export interface ShardBackendControlRequest {
  shardId: string;
  shardName: string;
  backend: Exclude<ShardBackend, 'inline'>;
  capabilityTier: CapabilityTier;
  sourceContext?: ShardSourceContext;
}

export interface ShardBackendController {
  readonly portFamily: 'shard_backend_controller';
  requestBackend(
    request: ShardBackendControlRequest,
  ): Promise<ShardBackendRequestResult>;
}

export function resolveRequestedShardBackend(config: Pick<ShardConfig, 'backend'>): ShardBackend {
  return config.backend ?? 'inline';
}

export function assertMediatedShardBackendTier(
  backend: ShardBackend,
  tier: CapabilityTier,
): void {
  if (backend === 'inline') {
    return;
  }

  const normalizedTier = normalizeCapabilityTier(tier);
  if (normalizedTier === 'autonomous' || normalizedTier === 'custom') {
    return;
  }

  throw new Error(
    `Shard backend "${backend}" requires autonomous or custom capability tier `
    + `(current: "${normalizedTier}").`,
  );
}

export class LocalShardBackendController implements ShardBackendController {
  readonly portFamily = 'shard_backend_controller' as const;

  async requestBackend(
    request: ShardBackendControlRequest,
  ): Promise<ShardBackendRequestResult> {
    return {
      backend: request.backend,
      controller: 'local',
      status: 'unavailable',
      reason:
        `Shard backend "${request.backend}" requires gateway or orchestrator mediation; `
        + 'no mediated backend controller is available in this runtime.',
    };
  }
}

export class GatewayShardBackendController implements ShardBackendController {
  readonly portFamily = 'shard_backend_controller' as const;

  constructor(private readonly gateway: GatewayClient) {}

  async requestBackend(
    request: ShardBackendControlRequest,
  ): Promise<ShardBackendRequestResult> {
    const params: ShardBackendRequestParams = {
      shardId: request.shardId,
      name: request.shardName,
      backend: request.backend,
      capabilityTier: request.capabilityTier,
      ...(request.sourceContext?.channelId ? { channelId: request.sourceContext.channelId } : {}),
      ...(request.sourceContext?.requestId ? { requestId: request.sourceContext.requestId } : {}),
      ...(request.sourceContext?.turnId ? { turnId: request.sourceContext.turnId } : {}),
    };
    return await this.gateway.shardBackendRequest(params);
  }
}
