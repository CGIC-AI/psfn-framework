import type { ShardConfig, ShardResult } from './types.js';
import type { ActiveShard, SatelliteDelegationRequest } from './manager.js';
import type {
  ShardFoldReviewPort,
} from './fold-review.js';

export interface ShardExecutionPort extends Partial<ShardFoldReviewPort> {
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
  delegateSatelliteSession(request: SatelliteDelegationRequest): Promise<ShardResult>;
  getActiveCount(): number;
  getActiveShards(): ActiveShard[];
}

export function createShardExecutionPort(port: ShardExecutionPort): ShardExecutionPort {
  return port;
}
