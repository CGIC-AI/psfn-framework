import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ShardConfig, ShardResult } from './types.js';

export const EXECUTION_PORT_FAMILIES = ['subagent', 'shard', 'artifact'] as const;

export type ExecutionPortFamily = typeof EXECUTION_PORT_FAMILIES[number];

export interface SubagentExecutionRequest {
  name: string;
  task: string;
  systemPrompt?: string;
  maxTurns?: number;
  capabilities?: readonly string[];
  requiredCapabilities?: readonly string[];
}

export interface SubagentExecutionPort {
  readonly portFamily: 'subagent';
  execute(request: SubagentExecutionRequest): Promise<AgentToolResult<{ isError?: boolean }>>;
}

export interface ShardExecutionPort {
  readonly portFamily: 'shard';
  spawn(shardConfig: ShardConfig): Promise<ShardResult>;
}

export interface ArtifactReturnPort {
  readonly portFamily: 'artifact';
  returnArtifact(result: ShardResult): AgentToolResult<{ isError?: boolean }>;
}
