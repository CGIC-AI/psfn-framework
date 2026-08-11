import type { LLMProviderPort, LLMRequestMetadata } from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { HybridEpisodeSearchPort } from '../../../faculties/memory/retrieval/episode-search.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { TaskState, TaskType } from '../../../core/scheduler/types.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type {
  NestedAnalysisRunner,
  SandboxExecutionPort,
  SandboxExecutionPortSeed,
  SandboxFileRead,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';

export type {
  ChildProcessCodeExecutionBoundary,
  GatewayProcessExecutionBoundary,
  SandboxBrokerExecutionBoundary,
  SandboxCodeExecutionBoundary,
  SandboxCodeExecutionRequest,
  SandboxCodeExecutionResponse,
  SandboxDeniedCapability,
  SandboxExecutionBoundary,
  SandboxExecutionPort,
  SandboxExecutionPortSeed,
  SandboxFileRead,
  SandboxHostHelper,
  ShellExecView,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';

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

export interface FsListView {
  paths: string[];
  scannedEntries: number;
  maxEntries: number;
  maxScannedEntries: number;
  truncated: boolean;
  scanLimitReached: boolean;
  entryLimitReached: boolean;
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
  fsList?: (glob?: string, maxEntries?: number) => Promise<FsListView>;
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
  fileRead?: SandboxFileRead;
  fsReadMaxBytes?: number;
  executionPort?: SandboxExecutionPort | SandboxExecutionPortSeed | null;
  embeddingService: EmbeddingProviderPort | null;
  memoryStore: MemoryStorePort | null;
  episodeSearch?: HybridEpisodeSearchPort | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  getCapabilityTier?: () => CapabilityTier;
  runNestedAnalysis?: NestedAnalysisRunner;
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  mutationPolicy?: {
    allowRepoMutation?: boolean;
    allowWorkspaceWrite?: boolean;
  };
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

export type ContextGetter = () => unknown;
