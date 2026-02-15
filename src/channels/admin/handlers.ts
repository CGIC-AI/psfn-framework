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
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { ContactStore } from '../../contacts/store.js';
import type { TrustLevel } from '../../trust/types.js';
import type { RelationshipType } from '../../contacts/types.js';
import { TRUST_LEVELS } from '../../trust/types.js';
import { VALID_RELATIONSHIP_TYPES } from '../../contacts/types.js';
import { MEMORY_CONFIG } from '../../memory/types.js';
import { loadSettings, saveSettings, applySettings, parseSettingsForm } from '../../settings.js';
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
  private modelDiscovery: ModelDiscovery | null;
  private contactStore: ContactStore | null;

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
    modelDiscovery?: ModelDiscovery | null;
    contactStore?: ContactStore | null;
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
    this.modelDiscovery = deps.modelDiscovery ?? null;
    this.contactStore = deps.contactStore ?? null;
  }

  // ── Login ──

  loginPage(error?: string): string {
    return tpl.loginPage(error);
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

  private getEnvInfo(): EnvInfo {
    return {
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
  }

  async settingsPage(): Promise<string> {
    const envInfo = this.getEnvInfo();
    const models = this.modelDiscovery
      ? await this.modelDiscovery.getAvailableModels().catch(() => undefined)
      : undefined;
    return tpl.layout('Settings', tpl.settingsPage(this.config, envInfo, models), 'settings');
  }

  updateSettings(body: string): string {
    const params = new URLSearchParams(body);
    const [settings, errors] = parseSettingsForm(params);

    if (errors.length > 0) {
      return tpl.settingsFormResult(false, errors.join('; '));
    }

    // Load existing saved settings, merge, save, and apply to live config
    const existing = loadSettings(this.config.dataDir);
    const merged = { ...existing, ...settings };
    saveSettings(this.config.dataDir, merged);
    applySettings(this.config, merged);

    return tpl.settingsFormResult(true, 'Settings saved');
  }

  primerPage(): string {
    return tpl.layout('Garden Primer', tpl.primerPage(), 'primer');
  }

  async modelListJson(): Promise<string> {
    if (!this.modelDiscovery) return '[]';
    const models = await this.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }

  async refreshModels(): Promise<string> {
    if (!this.modelDiscovery) return '[]';
    this.modelDiscovery.invalidateCache();
    const models = await this.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }

  // ── Contacts ──

  contactsPage(): string {
    if (!this.contactStore) {
      return tpl.layout('Garden Visitors', '<div class="empty">Contact store not available</div>', 'contacts');
    }
    const contacts = this.contactStore.listAll();
    return tpl.layout('Garden Visitors', tpl.contactsPage(contacts), 'contacts');
  }

  contactsListFragment(): string {
    if (!this.contactStore) return '<tr><td colspan="6" class="empty">Contact store not available</td></tr>';
    const contacts = this.contactStore.listAll();
    if (contacts.length === 0) return '<tr><td colspan="6" class="empty">No visitors found</td></tr>';
    // Re-render the full table body by using the contactsPage internals
    // We need individual rows, so return the page content minus wrapper
    return tpl.contactsPage(contacts);
  }

  contactEditFormFragment(contactId: string): string {
    if (!this.contactStore) return '';
    const contact = this.contactStore.getById(contactId);
    if (!contact) return '';
    return tpl.contactEditForm(contact);
  }

  handleContactUpdate(contactId: string, body: string): string {
    if (!this.contactStore) {
      return tpl.settingsFormResult(false, 'Contact store not available');
    }

    const contact = this.contactStore.getById(contactId);
    if (!contact) {
      return tpl.settingsFormResult(false, 'Contact not found');
    }

    const params = new URLSearchParams(body);
    const trustLevel = params.get('trustLevel') as TrustLevel | null;
    const relationshipType = params.get('relationshipType') as RelationshipType | null;
    const notes = params.get('notes');

    // Validate trust level
    if (trustLevel && !TRUST_LEVELS.includes(trustLevel)) {
      return tpl.settingsFormResult(false, `Invalid trust level: ${trustLevel}`);
    }

    // Validate relationship type
    if (relationshipType && !VALID_RELATIONSHIP_TYPES.includes(relationshipType)) {
      return tpl.settingsFormResult(false, `Invalid relationship type: ${relationshipType}`);
    }

    // Apply updates — order matters: upsert first (may reset trust), then setTrustLevel
    if (relationshipType && relationshipType !== contact.relationshipType && contact.discordUserId) {
      // Update via upsert — requires discordUserId for existing record lookup
      this.contactStore.upsert({
        ...contact,
        relationshipType,
        trustLevel: trustLevel ?? contact.trustLevel,
      });
    }

    if (trustLevel && trustLevel !== contact.trustLevel) {
      this.contactStore.setTrustLevel(contactId, trustLevel);
    }

    if (notes !== null) {
      this.contactStore.updateNotes(contactId, notes);
    }

    // Return the updated row
    const updated = this.contactStore.getById(contactId);
    if (!updated) return tpl.settingsFormResult(false, 'Update failed');

    // Return a fresh table row so htmx replaces the edit form
    return tpl.contactRow(updated);
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
      'agent.tool.start',
      'agent.tool.end',
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
