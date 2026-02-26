import type vm from 'node:vm';
import type { LLMProvider, EmbeddingService } from '../../agent-loop.js';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { TaskState, TaskType } from '../../scheduler/types.js';
import type { EventBus } from '../../event-bus.js';
import type { CapabilityTier } from '../../types.js';
import type { ConfirmationQueue } from '../../capabilities/confirmation-queue.js';
import type { ModuleRegistryMutation } from '../../modules/types.js';

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

export type { ModuleRecord } from '../../modules/types.js';

export type GatewayREPLCapabilities = {
  webFetch?: (url: string, prompt?: string) => Promise<string>;
  gitStatus?: () => Promise<GitStatusView>;
  gitDiff?: (opts?: { staged?: boolean }) => Promise<GitDiffView>;
  gitApplyPatch?: (filePath: string, content: string) => Promise<void>;
  gitCommit?: (message: string, intent: string, scope?: string) => Promise<GitCommitView>;
  fsRead?: (path: string) => Promise<string>;
  fsWrite?: (path: string, content: string) => Promise<void>;
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
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  getCapabilityTier?: () => CapabilityTier;
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
}

export interface SandboxBudgetRef {
  subQueries: number;
  maxSubQueries: number;
}

export interface ExecuteResult {
  output: string;
  error: string | null;
  finalAnswer: string | null;
  variablesChanged: string[];
}

export type ContextGetter = () => vm.Context;
