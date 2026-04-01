export type { SubagentExecutionPort } from '../subagents/port.js';
export type { SubagentExecutionRequest, SubagentResult } from '../subagents/types.js';
import type { ShardConfig, ShardResult } from './types.js';

export const EXECUTION_PORT_FAMILIES = ['subagent', 'shard', 'artifact'] as const;

export type ExecutionPortFamily = typeof EXECUTION_PORT_FAMILIES[number];

export interface ShardExecutionPort {
  readonly portFamily: 'shard';
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
}

export interface ArtifactReturnPort {
  readonly portFamily: 'artifact';
  returnArtifact(result: ShardResult): AgentToolResult<{ isError?: boolean }>;
}
