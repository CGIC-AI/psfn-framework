import type { ShardConfig, ShardResult } from './types.js';
import type { ActiveShard, SatelliteDelegationRequest } from './manager.js';

export interface ShardExecutionPort {
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
  delegateSatelliteSession(request: SatelliteDelegationRequest): Promise<ShardResult>;
  getActiveCount(): number;
  getActiveShards(): ActiveShard[];
}

export function createShardExecutionPort(port: ShardExecutionPort): ShardExecutionPort {
  return port;
}
