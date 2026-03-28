import type { ShardConfig, ShardResult } from './types.js';
import type { ActiveShard, WyomingShardDelegationRequest } from './manager.js';

export interface ShardExecutionPort {
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
  delegateWyomingSession(request: WyomingShardDelegationRequest): Promise<ShardResult>;
  getActiveCount(): number;
  getActiveShards(): ActiveShard[];
}

export function createShardExecutionPort(port: ShardExecutionPort): ShardExecutionPort {
  return port;
}
