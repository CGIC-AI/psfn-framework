import type {
  ShardConfig,
  ShardConfigurationMutationResult,
  ShardConfigurationSnapshot,
  ShardResult,
} from './types.js';
import type { ActiveShard, SatelliteDelegationRequest } from './manager.js';
import type {
  ShardFoldReviewPort,
} from './fold-review.js';

export interface ShardConfigurationPort {
  getShardConfigurationSnapshot(
    parentCompanionId: string,
    shardId: string,
  ): ShardConfigurationSnapshot | null;
  updateShardConfigurationOverrides(input: {
    parentCompanionId: string;
    shardId: string;
    actor: string;
    override: unknown;
  }): ShardConfigurationMutationResult;
}

export interface ShardExecutionPort
  extends Partial<ShardFoldReviewPort>, Partial<ShardConfigurationPort> {
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
  delegateSatelliteSession(request: SatelliteDelegationRequest): Promise<ShardResult>;
  getActiveCount(): number;
  getActiveShards(): ActiveShard[];
}

export function createShardExecutionPort(port: ShardExecutionPort): ShardExecutionPort {
  return port;
}
