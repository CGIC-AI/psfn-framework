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
}

export interface DashboardStats {
  memoryTotal: number;
  memoryByType: Record<string, number>;
  avgSalience: number;
  sessionCount: number;
  schedulerTasks: number;
  activeShards: number;
}

export interface AdminEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface ChannelInfo {
  channelId: string;
  messageCount: number;
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
