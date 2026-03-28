// ── Admin GUI Types ──

import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardExecutionPort } from '../../shards/port.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { EmbeddingService } from '../../core/agent/contracts.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { PromptLayerStore } from '../../core/identity/prompt-store.js';
import type { PromptRegistryStore } from '../../core/identity/prompt-registry.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import type { SkillsRuntime } from '../../skills/runtime.js';
import type { AdaptiveToolRuntimeState } from '../../core/agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from '../../core/agent/tool-catalog.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
} from '../../boundary/gateway/protocol.js';
import type { AdminToolHealthProvider } from './tool-health-provider.js';

export interface ConfirmationQueueAdminApi {
  listConfirmationQueue(): Promise<ConfirmationListResult>;
  resolveConfirmationQueue(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult>;
}

export interface AdaptiveToolsStateProvider {
  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState;
  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot;
}

export interface AdminModelDiscoveryBackend {
  getAvailableModels(): Promise<unknown[]>;
  invalidateCache(): void;
}

export interface AdminServerConfig {
  port: number;
  host?: string;
  token?: string;
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
  eventBus: EventBus;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  embeddingService: EmbeddingService | null;
  modelDiscovery?: AdminModelDiscoveryBackend | null;
  promptStore?: PromptLayerStore | null;
  promptRegistry?: PromptRegistryStore | null;
  cardVersionStore?: CharacterCardVersionStore | null;
  skillsRuntime?: SkillsRuntime | null;
  confirmationQueueApi?: ConfirmationQueueAdminApi | null;
  adaptiveToolsStateProvider?: AdaptiveToolsStateProvider | null;
  toolHealthProvider?: AdminToolHealthProvider | null;
}

export type DashboardCostWindow = 'today' | 'week' | 'month';

export interface DashboardCostWindowUsage {
  turns: number;
  llmCalls: number;
  toolCalls: number;
  estimatedCostUsd: number;
}

export interface DashboardCostWindowTotals {
  today: DashboardCostWindowUsage;
  week: DashboardCostWindowUsage;
  month: DashboardCostWindowUsage;
}

export interface DashboardSessionContextPressure {
  sessionId: string | null;
  utilizationPct: number;
  hasTelemetry: boolean;
}

export interface DashboardStats {
  memoryTotal: number;
  memoryByType: Record<string, number>;
  avgSalience: number;
  sessionCount: number;
  schedulerTasks: number;
  activeShards: number;
  sessionUsage: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    llmCalls: number;
    toolCalls: number;
    activeSessionContextPressure: DashboardSessionContextPressure;
    estimatedCostUsd: number;
    costWindows: {
      selected: DashboardCostWindow;
      byWindow: DashboardCostWindowTotals;
    };
  };
  recentThinkTraces: ThinkTraceView[];
}

export interface ThinkTraceStepView {
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
  durationMs: number;
  code: string;
  output: string;
  error: string | null;
  variablesChanged: string[];
}

export interface ThinkTraceView {
  timestamp: number;
  task: string;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStop: string | null;
  steps: ThinkTraceStepView[];
}

export interface AdminEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type AdminAuditActionType = 'tool_invocation' | 'identity_edit' | 'external_action' | 'memory_mutation' | 'settings_change';
export type AdminAuditDecision = 'allowed' | 'denied';
export type AdminAuditTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all';
export type AdminAuditActor = 'operator' | 'companion';

export interface AdminAuditTimelineEntry {
  id: string;
  timestamp: number;
  actionType: AdminAuditActionType;
  decision: AdminAuditDecision;
  narrative: string;
  details?: string;
  actor?: AdminAuditActor;
}

export interface AdminAuditTimelineFilters {
  actionType: AdminAuditActionType | 'all';
  decision: AdminAuditDecision | 'all';
  timeRange: AdminAuditTimeRange;
}

export type AdminChatDebugCategory = 'thinking' | 'text' | 'tools' | 'memory' | 'errors';

export type AdminChatDebugDetailValue = string | number | boolean | null;

export interface AdminChatDebugEventPayload {
  id: string;
  timestamp: number;
  event: string;
  category: AdminChatDebugCategory;
  channelId?: string;
  message: string;
  details?: Record<string, AdminChatDebugDetailValue>;
}

export interface AdminChatDebugStreamOptions {
  channelId?: string;
}

export interface ChannelInfo {
  sessionId: string;
  channelId: string;
  messageCount: number;
  lastActivityAt?: number;
  displayLabel?: string;
  linkedContactId?: string;
  linkedContactName?: string;
}

export type CompactionAuditVerification = 'verified' | 'mismatch' | 'missing_hash' | 'missing_source';

export interface CompactionAuditView {
  id: number;
  createdAt: number;
  coveredUpTo: number;
  summary: string;
  sourceHash: string | null;
  sourceFirstMessageId: number | null;
  sourceLastMessageId: number | null;
  sourceMessageCount: number | null;
  verification: CompactionAuditVerification;
  verificationDetail: string;
}

export interface EnvInfo {
  salienceFloor: number;
  maintenanceIntervalMs: number;
  discordToken: string;
  apiKey: string;
  adminToken: string;
  openrouterApiKey: string;
  litellmBaseUrl: string;
  litellmApiKey: string;
  importProcessingLocalApiKey: string;
  telegramBotToken: string;
}
