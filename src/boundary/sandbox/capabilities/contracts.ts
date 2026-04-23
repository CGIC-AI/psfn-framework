import type vm from 'node:vm';
import type { LLMProviderPort, EmbeddingProviderPort, LLMRequestMetadata } from '../../../core/agent/contracts.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { TaskState, TaskType } from '../../../core/scheduler/types.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { NestedThinkRunner } from '../../../core/tools/think/types.js';

export interface GitStatusView {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitDiffView {
  staged: string;
  unstaged: string;
}

export interface GitCommitView {
  hash: string;
  message: string;
  filesChanged: number;
}

export interface ShellExecView {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxBrokerExecutionBoundary {
  kind: 'sandbox_broker';
  isolatedFromGatewaySecrets: true;
  brokerId?: string;
}

export interface GatewayProcessExecutionBoundary {
  kind: 'gateway_process';
  isolatedFromGatewaySecrets: false;
  reason: string;
}

export type SandboxExecutionBoundary =
  | SandboxBrokerExecutionBoundary
  | GatewayProcessExecutionBoundary;

export interface NodeVmCodeExecutionBoundary {
  kind: 'node_vm';
  isolatedFromGatewaySecrets: boolean;
  reason: string;
}

export type SandboxCodeExecutionBoundary = NodeVmCodeExecutionBoundary;

export interface SandboxCodeExecutionRequest {
  code: string;
  context: vm.Context;
  timeoutMs: number;
  memoryCeilingBytes?: number;
  assertMemoryCeiling?: () => void;
}

export interface SandboxExecutionPort {
  readonly boundary: SandboxExecutionBoundary;
  readonly codeExecutionBoundary: SandboxCodeExecutionBoundary;
  shellExec: (
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number; maxOutputChars?: number },
  ) => Promise<ShellExecView>;
  executeCode: (
    request: SandboxCodeExecutionRequest,
  ) => Promise<void>;
}

export type { ModuleRecord } from '../../../system/modules/types.js';

export type GatewayREPLCapabilities = {
  webFetch?: (
    url: string,
    prompt?: string,
    lane?: 'default' | 'local_crawler',
  ) => Promise<string>;
  gitStatus?: () => Promise<GitStatusView>;
  gitDiff?: (opts?: { staged?: boolean }) => Promise<GitDiffView>;
  gitApplyPatch?: (filePath: string, content: string) => Promise<void>;
  gitCommit?: (message: string, intent: string, scope?: string) => Promise<GitCommitView>;
  fsRead?: (path: string) => Promise<string>;
  fsWrite?: (path: string, content: string) => Promise<void>;
  fsList?: (glob?: string, maxEntries?: number) => Promise<string[]>;
};

export interface ScheduleView {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: TaskState;
}

export interface ScheduleMutationResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface SandboxDeps {
  llmProvider: LLMProviderPort;
  executionPort?: SandboxExecutionPort | null;
  embeddingService: EmbeddingProviderPort | null;
  memoryStore: MemoryStorePort | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  getCapabilityTier?: () => CapabilityTier;
  runNestedThink?: NestedThinkRunner;
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  requestMetadata?: Partial<LLMRequestMetadata>;
}

export interface SandboxBudgetRef {
  subQueries: number;
  maxSubQueries: number;
  toolCalls?: number;
  maxToolCalls?: number;
}

export interface ExecuteResult {
  output: string;
  error: string | null;
  finalAnswer: string | null;
  variablesChanged: string[];
}

export type ContextGetter = () => vm.Context;
