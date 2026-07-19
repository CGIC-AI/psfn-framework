import type {
  ActiveShard,
  SatelliteDelegationRequest,
  ShardConfig,
  ShardConfigurationMutationResult,
  ShardConfigurationSnapshot,
  ShardParentIcpPort,
  ShardResult,
} from './types.js';
import type {
  ShardFoldReviewPort,
} from './fold-review.js';
import type { ShardDirectoryPort } from '../../shared/contracts/shard-directory.js';

export type { ShardParentIcpPort } from './types.js';

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
  readonly shardDirectory: ShardDirectoryPort;
  readonly shardParentIcp: ShardParentIcpPort;
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
  delegateSatelliteSession(request: SatelliteDelegationRequest): Promise<ShardResult>;
  getActiveCount(): number;
  getActiveShards(): ActiveShard[];
}

export function createShardExecutionPort(port: ShardExecutionPort): ShardExecutionPort {
  return port;
}
