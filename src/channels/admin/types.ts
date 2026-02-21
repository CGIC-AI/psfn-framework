// ── Admin GUI Types ──

import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardManager } from '../../shards/manager.js';
import type { EventBus } from '../../event-bus.js';
import type { EmbeddingService } from '../../agent-loop.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { SkillsRuntime } from '../../skills/runtime.js';

export interface AdminServerConfig {
  port: number;
  host?: string;
  token?: string;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  shardManager: ShardManager;
  eventBus: EventBus;
  characterCard: CharacterCardV2;
  config: SubstrateConfig;
  embeddingService: EmbeddingService | null;
  modelDiscovery?: ModelDiscovery | null;
  promptStore?: PromptLayerStore | null;
  promptRegistry?: PromptRegistryStore | null;
  skillsRuntime?: SkillsRuntime | null;
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
    avgContextUtilization: number;
    estimatedCostUsd: number;
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
  channelId: string;
  messageCount: number;
  displayLabel?: string;
  linkedContactId?: string;
  linkedContactName?: string;
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
  ollamaUrl: string;
}
