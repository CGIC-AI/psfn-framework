/**
 * `@psfn/core/ports` entrypoint: explicit host-injection port contracts that
 * decouple the companion core from optional host modules (gateway, CogSec
 * intake firewall, wiki, skills, channels, caches, and external runners).
 */
export type {
  LLMProviderPort,
  LLMProviderStreamOptions,
  MemoryProvider,
  WikiRetrievalPort,
} from '../../../src/core/agent/contracts.js';
export type { SubstrateStreamTransport } from '../../../src/core/agent/stream-adapter.js';
export type { EmbeddingProviderPort } from '../../../src/shared/contracts/embedding-provider.js';
export type { EmbeddingRuntimeProvider } from '../../../src/faculties/memory/embedding.js';
export type {
  NotificationPort,
  NotificationSenderMetadata,
  NotifyNtfyParams,
  NotifyNtfyResult,
} from '../../../src/shared/contracts/notification-port.js';
export type { MessageSender } from '../../../src/system/lifecycle/notifications.js';
export type * from '../../../src/shared/contracts/intake-screening-port.js';
export type * from '../../../src/shared/contracts/intake-sink-gate-port.js';
export {
  EMPTY_PERSONAL_PROJECTS,
  type PersonalProjectStatus,
  type PersonalProjectSummary,
  type PersonalProjectWorkContext,
  type PersonalProjectsPort,
  type ProjectContactDmTarget,
  type ProjectPublicationMode,
} from '../../../src/shared/contracts/personal-projects-port.js';
export type {
  SleeptimeWikiPassPort,
  SleeptimeWikiPassRunInput,
  SleeptimeWikiPassRunResult,
  WikiContextSnapshot,
  WikiPassSkipReason,
  WikiRefreshStatus,
  WikiRetrievalContextClass,
} from '../../../src/shared/contracts/wiki-context.js';
export type {
  ChannelCapabilities,
  ChannelChatType,
  ChannelPromptAdapter,
  ChannelPromptDock,
  ChannelPromptRegistryPort,
  MessageHandlerOptions,
} from '../../../src/shared/contracts/channel-prompt-port.js';
export type {
  ReflectionNudgePort,
  SkillsRuntimePromptPort,
  TurnToolSummary,
} from '../../../src/shared/contracts/skills-runtime-port.js';
export type {
  MemoryDeletionApprovalPort,
  MemoryDeletionApprovalRequest,
  MemoryDeletionApprovalResult,
  MemoryDeletionProposalStorePort,
} from '../../../src/faculties/memory/deletion-proposals.js';
export type { SessionIntegrityProvider } from '../../../src/persistence/sessions/store-primitives.js';
export type { SessionTailCachePort } from '../../../src/persistence/sessions/session-tail-cache-port.js';
export type {
  HostedAutomatonOutcome,
  HostedAutomatonTask,
  SubagentHostExecutionPort,
} from '../../../src/faculties/subagents/host-execution.js';
export type { SubagentControlPort } from '../../../src/faculties/subagents/port.js';
export type {
  ModelUsageEventInput,
  ModelUsageRecorder,
} from '../../../src/shared/telemetry/model-usage.js';
export type { ProviderRuntime } from '../../../src/primitives/llm/provider-runtime.js';
export type { StartupTextEmotionClassifier } from '../../../src/app/startup/support/ml-warmup.js';
