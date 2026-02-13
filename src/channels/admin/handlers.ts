// ── Admin Route Handlers ──
// Each method returns an HTML string (full page or fragment).

import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardManager } from '../../shards/manager.js';
import type { EventBus, EventName, EventMap } from '../../event-bus.js';
import type { EmbeddingService } from '../../agent-loop.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type { DashboardStats, EnvInfo } from './types.js';
import { MEMORY_CONFIG } from '../../memory/types.js';
import * as tpl from './templates.js';

export class AdminHandlers {
  private memoryStore: MemoryStore;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private scheduler: Scheduler;
  private shardManager: ShardManager;
  private eventBus: EventBus;
  private embeddingService: EmbeddingService | null;
  private characterCard: CharacterCardV2;
  private config: SubstrateConfig;

  constructor(deps: {
    memoryStore: MemoryStore;
    sessionStore: SessionStore;
    sessionManager: SessionManager;
    scheduler: Scheduler;
    shardManager: ShardManager;
    eventBus: EventBus;
    embeddingService: EmbeddingService | null;
    characterCard: CharacterCardV2;
    config: SubstrateConfig;
  }) {
    this.memoryStore = deps.memoryStore;
    this.sessionStore = deps.sessionStore;
    this.sessionManager = deps.sessionManager;
    this.scheduler = deps.scheduler;
    this.shardManager = deps.shardManager;
    this.eventBus = deps.eventBus;
    this.embeddingService = deps.embeddingService;
    this.characterCard = deps.characterCard;
    this.config = deps.config;
  }

  // ── Dashboard ──

  dashboard(): string {
    const memStats = this.memoryStore.getStats();
    const channels = this.sessionStore.listChannels();
    const stats: DashboardStats = {
      memoryTotal: memStats.total,
      memoryByType: memStats.byType,
      avgSalience: memStats.avgSalience,
      sessionCount: channels.length,
      schedulerTasks: this.scheduler.taskCount,
      activeShards: this.shardManager.getActiveCount(),
    };
    return tpl.layout('Dashboard', tpl.dashboardPage(stats), 'dashboard');
  }

  // ── Memory ──

  memoryList(): string {
    const memories = this.memoryStore.getAllActiveMemories();
    return tpl.layout('Memory Blossoms', tpl.memoryListPage(memories), 'memory');
  }

  memoryDetail(id: string): string | null {
    const m = this.memoryStore.getById(id);
    if (!m) return null;
    return tpl.layout(`Memory: ${m.text.slice(0, 40)}...`, tpl.memoryDetailPage(m), 'memory');
  }

  memoryListFragment(): string {
    const memories = this.memoryStore.getAllActiveMemories();
    return memories.length > 0
      ? memories.map(m => tpl.memoryRow(m)).join('')
      : '<tr><td colspan="6" class="empty">No memories found</td></tr>';
  }

  async memorySearch(query: string): Promise<string> {
    if (!this.embeddingService) {
      return '<tr><td colspan="6" class="empty">Embedding service not available</td></tr>';
    }
    const embedding = await this.embeddingService.embed(query);
    const results = this.memoryStore.searchByEmbedding(embedding, 0.1, 50);
    return results.length > 0
      ? results.map(m => tpl.memoryRow(m)).join('')
      : '<tr><td colspan="6" class="empty">No matching memories</td></tr>';
  }

  memorySupersede(id: string): string {
    const m = this.memoryStore.getById(id);
    if (!m) return '';
    this.memoryStore.updateMemory(id, { supersededBy: `admin-${randomUUID()}` });
    return '';  // Remove the row
  }

  // ── Sessions ──

  sessionList(): string {
    const channels = this.sessionStore.listChannels();
    return tpl.layout('Conversation Roots', tpl.sessionListPage(channels), 'sessions');
  }

  sessionMessages(channelId: string): string {
    const messages = this.sessionManager.getRecentMessages(channelId, 100);
    return tpl.layout(`Session: ${channelId}`, tpl.sessionMessagesPage(channelId, messages), 'sessions');
  }

  sessionMessagesFragment(channelId: string): string {
    const messages = this.sessionManager.getRecentMessages(channelId, 100);
    return messages.map(m => tpl.messageCard(m)).join('');
  }

  // ── Scheduler ──

  schedulerPage(): string {
    const tasks = this.scheduler.listTasks();
    return tpl.layout('Garden Rhythms', tpl.schedulerPage(tasks), 'scheduler');
  }

  // ── Shards ──

  shardsPage(): string {
    const shards = this.shardManager.getActiveShards();
    return tpl.layout('Active Branches', tpl.shardsPage(shards), 'shards');
  }

  // ── Identity ──

  identityPage(): string {
    return tpl.layout('Identity', tpl.identityPage(this.characterCard, this.config), 'identity');
  }

  // ── Settings ──

  settingsPage(): string {
    const envInfo: EnvInfo = {
      salienceFloor: MEMORY_CONFIG.salienceFloor,
      maintenanceIntervalMs: MEMORY_CONFIG.maintenanceIntervalMs,
      discordToken: process.env.DISCORD_TOKEN ? 'configured' : 'not set',
      apiKey: process.env.API_KEY ? 'configured' : 'not set',
      adminToken: process.env.ADMIN_TOKEN ? 'configured' : 'not set',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ? 'configured' : 'not set',
      litellmBaseUrl: process.env.LITELLM_BASE_URL ? 'configured' : 'not set',
      litellmApiKey: process.env.LITELLM_API_KEY ? 'configured' : 'not set',
      ollamaUrl: process.env.OLLAMA_URL ? 'configured' : 'not set',
    };
    return tpl.layout('Settings', tpl.settingsPage(this.config, envInfo), 'settings');
  }

  // ── Events (SSE) ──

  eventsPageHtml(): string {
    return tpl.layout('Garden Pulse', tpl.eventsPage(), 'events');
  }

  setupSSE(res: ServerResponse): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Flush headers to client immediately (SSE requires this)
    res.write(':ok\n\n');

    const sseEvents: EventName[] = [
      'agent.turn.end',
      'agent.error',
      'memory.extraction.end',
      'memory.retrieval',
      'schedule.task.run',
      'schedule.heartbeat',
      'system.error',
    ];

    const unsubscribers: Array<() => void> = [];

    for (const eventName of sseEvents) {
      const unsub = this.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        const now = Date.now();
        const html = tpl.eventItem(eventName, now, data as Record<string, unknown>);
        res.write(`event: admin-event\ndata: ${html}\n\n`);
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }
}
