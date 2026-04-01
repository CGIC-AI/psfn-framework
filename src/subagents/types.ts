import type { SubagentWorkerLane } from '../agent/worker-lanes.js';
import type { SubstrateMessage, WyomingRoutingMetadata } from '../types.js';

export type SubagentTaskLifecycleState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentExecutionRequest {
  name: string;
  task: string;
  systemPrompt?: string;
  maxTurns?: number;
  capabilities?: readonly string[];
  requiredCapabilities?: readonly string[];
  executionChannelId?: string;
  message?: SubstrateMessage;
}

export interface WyomingSubagentDelegationRequest {
  message: SubstrateMessage;
  routing?: WyomingRoutingMetadata;
  subagentName?: string;
}

export interface SubagentTaskRecord {
  subagentId: string;
  name: string;
  task: string;
  workerLane: SubagentWorkerLane;
  channelId: string;
  lifecycleState: SubagentTaskLifecycleState;
  stateReason: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
}

export interface SubagentResult {
  subagentId: string;
  name: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
  workerLane: SubagentWorkerLane;
  lifecycleState: Extract<SubagentTaskLifecycleState, 'completed' | 'failed' | 'cancelled'>;
  stateReason: string;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
}
