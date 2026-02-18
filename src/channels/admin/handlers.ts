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
import type { DashboardStats, EnvInfo, ThinkTraceView } from './types.js';
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { TrustLevel } from '../../trust/types.js';
import type { Contact, RelationshipType, ChannelPrivacyLevel } from '../../contacts/types.js';
import { TRUST_LEVELS } from '../../trust/types.js';
import { VALID_RELATIONSHIP_TYPES, CHANNEL_PRIVACY_LEVELS } from '../../contacts/types.js';
import { MEMORY_CONFIG } from '../../memory/types.js';
import { loadSettings, saveSettings, applySettings, parseSettingsForm } from '../../settings.js';
import {
  AdminChatBootstrapService,
  type AdminChatBootstrapResponse,
  type AdminChatBootstrapUpdateInput,
} from './chat/index.js';
import * as tpl from './templates.js';

interface ContactIdentityLinkView {
  channel: string;
  userId: string;
  lastSeen?: string;
}

interface ContactConversationChannelView {
  channel: string;
  channelId: string;
  lastSeen?: string;
}

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
  private promptStore: PromptLayerStore | null;
  private promptRegistry: PromptRegistryStore | null;
  private chatBootstrapService: AdminChatBootstrapService;
  private usageTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    llmCalls: 0,
    toolCalls: 0,
    contextUtilizationSum: 0,
    estimatedCostUsd: 0,
  };
  private thinkTraces: ThinkTraceView[] = [];

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
    promptStore?: PromptLayerStore | null;
    promptRegistry?: PromptRegistryStore | null;
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
    this.promptStore = deps.promptStore ?? null;
    this.promptRegistry = deps.promptRegistry ?? null;
    this.chatBootstrapService = new AdminChatBootstrapService(this.contactStore);

    this.eventBus.on('agent.turn.usage', ({ usage }) => {
      this.usageTotals.turns += 1;
      this.usageTotals.inputTokens += usage.inputTokens;
      this.usageTotals.outputTokens += usage.outputTokens;
      this.usageTotals.cacheReadTokens += usage.cacheReadTokens;
      this.usageTotals.llmCalls += usage.llmCalls;
      this.usageTotals.toolCalls += usage.toolCalls;
      this.usageTotals.contextUtilizationSum += usage.contextUtilization;
      this.usageTotals.estimatedCostUsd += usage.estimatedCostUsd ?? 0;
    });

    this.eventBus.on('agent.think.trace', ({ timestamp, task, result }) => {
      const trace: ThinkTraceView = {
        timestamp,
        task,
        iterations: result.iterations,
        totalTokens: result.totalInputTokens + result.totalOutputTokens,
        durationMs: result.durationMs,
        truncated: result.truncated,
        budgetStop: result.budgetStop,
        steps: result.steps.map(step => ({
          iteration: step.iteration,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          cumulativeTokens: step.cumulativeTokens,
          durationMs: step.durationMs,
          code: step.code,
          output: step.output,
          error: step.error,
          variablesChanged: step.variablesChanged,
        })),
      };

      this.thinkTraces.unshift(trace);
      if (this.thinkTraces.length > 5) this.thinkTraces.length = 5;
    });
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
      sessionUsage: {
        turns: this.usageTotals.turns,
        inputTokens: this.usageTotals.inputTokens,
        outputTokens: this.usageTotals.outputTokens,
        cacheReadTokens: this.usageTotals.cacheReadTokens,
        llmCalls: this.usageTotals.llmCalls,
        toolCalls: this.usageTotals.toolCalls,
        avgContextUtilization: this.usageTotals.turns > 0
          ? this.usageTotals.contextUtilizationSum / this.usageTotals.turns
          : 0,
        estimatedCostUsd: this.usageTotals.estimatedCostUsd,
      },
      recentThinkTraces: this.thinkTraces,
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
    try {
      this.config.runtimeHooks?.refreshModels?.();
    } catch {
      // Keep settings save successful even if runtime model refresh fails.
      // Next turn will still re-attempt refresh through SubstrateAgent drift detection.
    }

    return tpl.settingsFormResult(true, 'Settings saved');
  }

  primerPage(): string {
    return tpl.layout('Garden Primer', tpl.primerPage(), 'primer');
  }

  // ── Chat ──

  chatPage(): string {
    const body = `
      <div class="card">
        <p>Admin chat cockpit bootstrap is available at <code>/api/chat/bootstrap</code>.</p>
      </div>
    `;
    return tpl.layout('Chat Cockpit', body, 'chat');
  }

  chatBootstrap(): AdminChatBootstrapResponse {
    return this.chatBootstrapService.buildBootstrap();
  }

  updateChatBootstrap(
    body: string,
    contentTypeHeader: string | string[] | undefined,
  ): AdminChatBootstrapResponse {
    const update = this.parseChatBootstrapUpdate(body, contentTypeHeader);
    return this.chatBootstrapService.updateSelection(update);
  }

  private parseChatBootstrapUpdate(
    body: string,
    contentTypeHeader: string | string[] | undefined,
  ): AdminChatBootstrapUpdateInput {
    const contentType = Array.isArray(contentTypeHeader)
      ? (contentTypeHeader[0] ?? '')
      : (contentTypeHeader ?? '');
    const normalizedContentType = contentType.toLowerCase();
    const trimmedBody = body.trim();
    if (!trimmedBody) return {};

    if (normalizedContentType.includes('application/json') || trimmedBody.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedBody);
      } catch {
        throw new Error('Invalid JSON payload');
      }
      return this.parseChatBootstrapUpdateObject(parsed);
    }

    const params = new URLSearchParams(body);
    const privacyLevel = params.get('privacyLevel');

    return {
      canonicalContactId: params.get('canonicalContactId') ?? undefined,
      channel: params.get('channel') ?? undefined,
      userId: params.get('userId') ?? undefined,
      privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
      defaultAuthorName: params.get('defaultAuthorName') ?? undefined,
      defaultAuthorId: params.get('defaultAuthorId') ?? undefined,
    };
  }

  private parseChatBootstrapUpdateObject(parsed: unknown): AdminChatBootstrapUpdateInput {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON payload must be an object');
    }

    const payload = parsed as Record<string, unknown>;
    const privacyLevel = this.readOptionalStringField(payload, 'privacyLevel');

    return {
      canonicalContactId: this.readOptionalStringField(payload, 'canonicalContactId'),
      channel: this.readOptionalStringField(payload, 'channel'),
      userId: this.readOptionalStringField(payload, 'userId'),
      privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
      defaultAuthorName: this.readOptionalStringField(payload, 'defaultAuthorName'),
      defaultAuthorId: this.readOptionalStringField(payload, 'defaultAuthorId'),
    };
  }

  private readOptionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Field "${key}" must be a string`);
    }
    return value;
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

  private getContactNickname(contact: Contact): string | undefined {
    const nickname = (contact as Contact & { nickname?: string }).nickname;
    if (typeof nickname !== 'string') return undefined;
    const trimmed = nickname.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private getContactIdentityLinks(contact: Contact): ContactIdentityLinkView[] {
    if (Array.isArray(contact.channels) && contact.channels.length > 0) {
      return contact.channels.map(channel => ({
        channel: channel.channel,
        userId: channel.userId,
        lastSeen: channel.lastSeen,
      }));
    }

    if (!Array.isArray(contact.channelIdentities)) return [];
    return contact.channelIdentities.map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
      lastSeen: contact.lastSeen,
    }));
  }

  private getPersistedConversationChannels(contact: Contact): ContactConversationChannelView[] {
    if (!Array.isArray(contact.conversationChannels) || contact.conversationChannels.length === 0) {
      return [];
    }

    return contact.conversationChannels.map(entry => ({
      channel: entry.channel,
      channelId: entry.channelId,
      lastSeen: entry.lastSeen,
    }));
  }

  private splitSessionChannelId(channelId: string): { channel: string; channelId: string } {
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) {
      return { channel: 'session', channelId };
    }

    return {
      channel: channelId.slice(0, separatorIndex),
      channelId: channelId.slice(separatorIndex + 1),
    };
  }

  private sessionMatchesIdentity(sessionChannelId: string, identity: ContactIdentityLinkView): boolean {
    const normalizedSession = sessionChannelId.trim().toLowerCase();
    const normalizedChannel = identity.channel.trim().toLowerCase();
    const normalizedUserId = identity.userId.trim().toLowerCase();
    if (!normalizedUserId) return false;

    if (normalizedSession === normalizedUserId) return true;
    if (normalizedSession === `${normalizedChannel}:${normalizedUserId}`) return true;
    return normalizedSession.startsWith(`${normalizedChannel}:`) && normalizedSession.endsWith(`:${normalizedUserId}`);
  }

  private buildRelatedConversationChannelMap(contacts: Contact[]): Map<string, ContactConversationChannelView[]> {
    const sessions = this.sessionStore.listChannels();
    const map = new Map<string, ContactConversationChannelView[]>();

    for (const contact of contacts) {
      const persistedChannels = this.getPersistedConversationChannels(contact);
      if (persistedChannels.length > 0) {
        map.set(contact.id, persistedChannels);
        continue;
      }

      const identities = this.getContactIdentityLinks(contact);
      const relatedChannels: ContactConversationChannelView[] = [];
      const seen = new Set<string>();

      for (const session of sessions) {
        if (!identities.some(identity => this.sessionMatchesIdentity(session.channelId, identity))) continue;

        const parsed = this.splitSessionChannelId(session.channelId);
        const key = `${parsed.channel}:${parsed.channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const lastEntry = this.sessionStore.getLastEntry(session.channelId);
        relatedChannels.push({
          channel: parsed.channel,
          channelId: parsed.channelId,
          lastSeen: lastEntry ? new Date(lastEntry.timestamp).toISOString() : undefined,
        });
      }

      if (relatedChannels.length === 0) {
        for (const identity of identities) {
          const key = `${identity.channel}:${identity.userId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          relatedChannels.push({
            channel: identity.channel,
            channelId: identity.userId,
            lastSeen: identity.lastSeen ?? contact.lastSeen,
          });
        }
      }

      map.set(contact.id, relatedChannels);
    }

    return map;
  }

  private updateIdentityProfile(contact: Contact, displayName: string, nickname: string | undefined): boolean {
    if (!this.contactStore) return false;
    const storeWithIdentityProfile = this.contactStore as ContactStore & {
      updateIdentityProfile?: (contactId: string, displayName: string, nickname?: string) => boolean;
    };

    if (typeof storeWithIdentityProfile.updateIdentityProfile === 'function') {
      return storeWithIdentityProfile.updateIdentityProfile(contact.id, displayName, nickname);
    }

    const updated = this.contactStore.upsert({
      id: contact.id,
      displayName,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      notes: contact.notes,
      discordUserId: contact.discordUserId,
      channels: contact.channels,
      channelIdentities: contact.channelIdentities,
      firstSeen: contact.firstSeen,
    });
    return updated.id === contact.id;
  }

  contactsPage(): string {
    if (!this.contactStore) {
      return tpl.layout('Garden Visitors', '<div class="empty">Contact store not available</div>', 'contacts');
    }
    const contacts = this.contactStore.listAll();
    const profileMap = new Map(
      this.memoryStore.listContactProfiles().map(profile => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.buildRelatedConversationChannelMap(contacts);
    return tpl.layout('Garden Visitors', tpl.contactsPage(contacts, profileMap, relatedChannelMap), 'contacts');
  }

  contactsListFragment(): string {
    if (!this.contactStore) return '<tr><td colspan="5" class="empty">Contact store not available</td></tr>';
    const contacts = this.contactStore.listAll();
    if (contacts.length === 0) return '<tr><td colspan="5" class="empty">No visitors found</td></tr>';
    const profileMap = new Map(
      this.memoryStore.listContactProfiles().map(profile => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.buildRelatedConversationChannelMap(contacts);
    return contacts.map(contact => tpl.contactRow(
      contact,
      profileMap.get(contact.id),
      relatedChannelMap.get(contact.id) ?? [],
    )).join('');
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
    const displayName = (params.get('displayName') ?? '').trim();
    const nicknameField = params.get('nickname');
    const nickname = nicknameField === null ? undefined : (nicknameField.trim() || undefined);
    const trustLevel = params.get('trustLevel') as TrustLevel | null;
    const relationshipType = params.get('relationshipType') as RelationshipType | null;
    const notes = params.get('notes');
    const channelCount = Number.parseInt(params.get('channelCount') ?? '0', 10);
    const newChannel = (params.get('newChannel') ?? '').trim();
    const newChannelUserId = (params.get('newChannelUserId') ?? '').trim();
    const newChannelPrivacyRaw = (params.get('newChannelPrivacy') ?? '').trim();
    const newChannelPrivacy = newChannelPrivacyRaw as ChannelPrivacyLevel;
    const currentNickname = this.getContactNickname(contact);

    if (!displayName) {
      return tpl.settingsFormResult(false, 'Display name is required');
    }

    const channelPrivacyUpdates: Array<{
      channel: string;
      channelUserId: string;
      privacyLevel: ChannelPrivacyLevel;
    }> = [];

    if (!Number.isNaN(channelCount) && channelCount > 0) {
      for (let index = 0; index < channelCount; index += 1) {
        const channel = params.get(`channel_${index}`);
        const channelUserId = params.get(`channelUserId_${index}`);
        const privacyLevel = params.get(`channelPrivacy_${index}`);
        if (!channel || !channelUserId || !privacyLevel) continue;
        if (!CHANNEL_PRIVACY_LEVELS.includes(privacyLevel as ChannelPrivacyLevel)) {
          return tpl.settingsFormResult(false, `Invalid channel privacy level: ${privacyLevel}`);
        }
        channelPrivacyUpdates.push({
          channel,
          channelUserId,
          privacyLevel: privacyLevel as ChannelPrivacyLevel,
        });
      }
    }

    // Validate trust level
    if (trustLevel && !TRUST_LEVELS.includes(trustLevel)) {
      return tpl.settingsFormResult(false, `Invalid trust level: ${trustLevel}`);
    }

    // Validate relationship type
    if (relationshipType && !VALID_RELATIONSHIP_TYPES.includes(relationshipType)) {
      return tpl.settingsFormResult(false, `Invalid relationship type: ${relationshipType}`);
    }

    if (
      (newChannel || newChannelUserId || newChannelPrivacyRaw)
      && (!newChannel || !newChannelUserId)
    ) {
      return tpl.settingsFormResult(false, 'To link a new channel, both channel and channel user ID are required');
    }

    if (newChannel && !CHANNEL_PRIVACY_LEVELS.includes(newChannelPrivacy)) {
      return tpl.settingsFormResult(false, `Invalid new channel privacy level: ${newChannelPrivacyRaw}`);
    }

    if (displayName !== contact.displayName || nickname !== currentNickname) {
      const updatedIdentity = this.updateIdentityProfile(contact, displayName, nickname);
      if (!updatedIdentity) {
        return tpl.settingsFormResult(false, 'Unable to update contact identity profile');
      }
    }

    if (trustLevel && trustLevel !== contact.trustLevel) {
      const updatedTrust = this.contactStore.setTrustLevel(contactId, trustLevel);
      if (!updatedTrust) {
        return tpl.settingsFormResult(false, 'Unable to update trust level for this contact');
      }
    }

    if (relationshipType && relationshipType !== contact.relationshipType) {
      const updatedRelationship = this.contactStore.updateRelationshipType(contactId, relationshipType);
      if (!updatedRelationship) {
        return tpl.settingsFormResult(false, 'Unable to update relationship type for this contact');
      }
    }

    if (notes !== null) {
      this.contactStore.updateNotes(contactId, notes);
    }

    for (const update of channelPrivacyUpdates) {
      const updated = this.contactStore.setChannelPrivacy(
        contactId,
        update.channel,
        update.channelUserId,
        update.privacyLevel,
      );
      if (!updated) {
        return tpl.settingsFormResult(
          false,
          `Unable to update channel privacy for ${update.channel}:${update.channelUserId}`,
        );
      }
    }

    if (newChannel && newChannelUserId) {
      const linkResult = this.contactStore.linkChannelIdentity(contactId, newChannel, newChannelUserId, {
        privacyLevel: newChannelPrivacy || 'semi_private',
      });
      if (linkResult === 'identity_conflict') {
        return tpl.settingsFormResult(false, `Identity ${newChannel}:${newChannelUserId} is already linked to another contact`);
      }
      if (linkResult === 'contact_not_found') {
        return tpl.settingsFormResult(false, 'Contact not found while linking new channel');
      }
    }

    // Return the updated row
    const updated = this.contactStore.getById(contactId);
    if (!updated) return tpl.settingsFormResult(false, 'Update failed');

    // Return a fresh table row so htmx replaces the edit form
    const relatedChannels = this.buildRelatedConversationChannelMap([updated]).get(updated.id) ?? [];
    return tpl.contactRow(updated, this.memoryStore.getContactProfile(updated.id), relatedChannels);
  }

  // ── Prompt Stack ──

  promptsPage(): string {
    const layers = this.promptStore?.getAll() ?? [];
    const prompts = this.promptRegistry?.list() ?? [];
    return tpl.layout('Prompt Soil', tpl.promptsPage(layers, prompts), 'prompts');
  }

  promptDetail(layerId: string): string | null {
    if (!this.promptStore) return null;
    const layer = this.promptStore.getById(layerId);
    if (!layer) return null;
    const history = this.promptStore.getLayerHistory(layerId);
    return tpl.layout(
      `${layer.name} -- Prompt Soil`,
      tpl.promptDetailPage(layer, history),
      'prompts',
    );
  }

  promptRegistryDetail(key: string): string | null {
    if (!this.promptRegistry) return null;
    const prompt = this.promptRegistry.getByKey(key);
    if (!prompt) return null;
    const history = this.promptRegistry.getPromptHistory(key);
    return tpl.layout(
      `${prompt.key} -- Prompt Registry`,
      tpl.promptRegistryDetailPage(prompt, history),
      'prompts',
    );
  }

  updatePromptLayer(body: string): string {
    if (!this.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const content = params.get('content') ?? '';
    try {
      const layer = this.promptStore.update(layerId, content, 'admin');
      return tpl.settingsFormResult(true, `Updated "${layer.name}" to v${layer.version}`);
    } catch (err) {
      return tpl.settingsFormResult(false, String(err));
    }
  }

  updatePromptRegistry(body: string): string {
    if (!this.promptRegistry) return '<div class="form-error">Prompt registry not configured</div>';
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const content = params.get('content') ?? '';
    try {
      const prompt = this.promptRegistry.update(key, content, 'admin');
      return tpl.settingsFormResult(true, `Updated "${prompt.key}" to v${prompt.version}`);
    } catch (err) {
      return tpl.settingsFormResult(false, String(err));
    }
  }

  togglePromptLayer(body: string): string {
    if (!this.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    try {
      this.promptStore.toggle(layerId);
      // Return the full updated list for htmx swap
      const layers = this.promptStore.getAll();
      return tpl.promptLayersFragment(layers);
    } catch (err) {
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptLayer(body: string): string {
    if (!this.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const layer = this.promptStore.rollback(layerId, version);
      return tpl.settingsFormResult(true, `Rolled back "${layer.name}" to content from v${version}`);
    } catch (err) {
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptRegistry(body: string): string {
    if (!this.promptRegistry) return '<div class="form-error">Prompt registry not configured</div>';
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const prompt = this.promptRegistry.rollback(key, version);
      return tpl.settingsFormResult(true, `Rolled back "${prompt.key}" to content from v${version}`);
    } catch (err) {
      return tpl.settingsFormResult(false, String(err));
    }
  }

  previewPromptLayerDiff(body: string): string {
    if (!this.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const proposed = params.get('content') ?? '';
    const layer = this.promptStore.getById(layerId);
    if (!layer) return '<div class="form-error">Prompt layer not found</div>';
    return tpl.promptDiffFragment(layer.content, proposed);
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
      'agent.turn.usage',
      'agent.tool.start',
      'agent.tool.end',
      'agent.compaction.start',
      'agent.compaction.end',
      'agent.retry.start',
      'agent.retry.end',
      'agent.think.trace',
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
