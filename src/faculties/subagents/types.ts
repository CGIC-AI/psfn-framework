import type { SubagentWorkerLane } from '../agent/worker-lanes.js';
import type { SessionEntry } from '../session/types.js';
import type { GatewayRoutingEnvelope, SubstrateMessage, WyomingRoutingMetadata } from '../types.js';

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
  gatewayRouting?: GatewayRoutingEnvelope;
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

export interface SubagentRuntimeArtifactView {
  kind: 'final_output';
  content: string;
  timestamp: number;
  sourceMessageId?: number;
}

export interface SubagentRuntimeResumeView {
  channelId: string;
  lifecycleState: SubagentTaskLifecycleState;
  resumable: boolean;
  transcriptAvailable: boolean;
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  lastActivityAt?: number;
  lastMessageId?: number;
}

export interface SubagentRuntimeTaskView {
  task: SubagentTaskRecord;
  transcript: SessionEntry[];
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  artifacts: SubagentRuntimeArtifactView[];
  resume: SubagentRuntimeResumeView;
}

export interface SubagentRuntimeTaskDetail {
  view: SubagentRuntimeTaskView;
  result?: SubagentResult;
}

export interface SubagentRuntimeSnapshot {
  generatedAt: number;
  activeCount: number;
  activeTasks: SubagentRuntimeTaskView[];
  recentTasks: SubagentRuntimeTaskView[];
}

export interface SubagentRuntimeSnapshotOptions {
  taskLimit?: number;
  transcriptLimit?: number;
}

export interface SubagentRuntimeSnapshotProvider {
  getRuntimeSnapshot(options?: SubagentRuntimeSnapshotOptions): SubagentRuntimeSnapshot;
}
