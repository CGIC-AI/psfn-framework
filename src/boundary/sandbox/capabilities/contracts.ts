import type vm from 'node:vm';
import type { LLMProvider, EmbeddingService, LLMRequestMetadata } from '../../../core/agent/contracts.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import type { TaskState, TaskType } from '../../../scheduler/types.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import type { ModuleRegistryMutation } from '../../../modules/types.js';
import type { NestedThinkRunner } from '../../../repl/types.js';

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

export interface SandboxExecutionPort {
  readonly boundary: SandboxExecutionBoundary;
  shellExec: (
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number; maxOutputChars?: number },
  ) => Promise<ShellExecView>;
}

export type { ModuleRecord } from '../../../modules/types.js';

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
  llmProvider: LLMProvider;
  executionPort?: SandboxExecutionPort | null;
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  getCapabilityTier?: () => CapabilityTier;
  runNestedThink?: NestedThinkRunner;
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
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
