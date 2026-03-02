// ── Admin Route Handlers ──
// Each method returns an HTML string (full page or fragment).

import type { ServerResponse } from 'node:http';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { CompactionSummary } from '../../session/types.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardManager } from '../../shards/manager.js';
import type { EventBus, EventName, EventMap } from '../../event-bus.js';
import type { EmbeddingService } from '../../agent/contracts.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type {
  DashboardStats,
  EnvInfo,
  ThinkTraceView,
  ConfirmationQueueAdminApi,
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  CompactionAuditView,
} from './types.js';
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerMetadataUpdate, PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import { PROMPT_LAYER_ROLES, type PromptLayerRole } from '../../identity/prompt-types.js';
import type { TrustLevel } from '../../trust/types.js';
import type {
  Contact,
  RelationshipType,
  ChannelPrivacyLevel,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditField,
  ContactMutationAuditQuery,
} from '../../contacts/types.js';
import type { SkillsRuntime } from '../../skills/runtime.js';
import { TRUST_LEVELS } from '../../trust/types.js';
import { VALID_RELATIONSHIP_TYPES, CHANNEL_PRIVACY_LEVELS } from '../../contacts/types.js';
import { MEMORY_CONFIG } from '../../memory/types.js';
import {
  loadSettings,
  saveSettings,
  applySettings,
  parseSettingsForm,
  normalizeEditableSettings,
} from '../../settings.js';
import {
  loadModelsConfig,
  saveModelsConfig,
  type ModelsRuntimeConfig,
} from '../../config/models-config.js';
import {
  loadSkillsConfig,
  saveSkillsConfig,
  type SkillsRuntimeConfig,
} from '../../config/skills-config.js';
import {
  loadSchedulerConfig,
  saveSchedulerConfig,
  type SchedulerRuntimeConfig,
} from '../../config/scheduler-config.js';
import {
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
  type TrustPolicyConfig,
} from '../../config/trust-policy-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
  type CapabilityTierConfig,
} from '../../config/capability-tier-config.js';
import { resolveRuntimeSchedulerConfig } from '../../config/scheduler-runtime.js';
import { setRuntimeTrustPolicy } from '../../trust/runtime-policy.js';
import { CAPABILITY_TIER_VALUES, isCapabilityTier } from '../../capabilities/tiers.js';
import { isCapabilityToken } from '../../capabilities/tokens.js';
import type { CapabilityToken } from '../../capabilities/tokens.js';
import type {
  ConfirmationResolveParams,
  ConfirmationResolveResult,
} from '../../gateway/protocol.js';
import {
  containsStructuredPromptSections,
  getMalformedStructuredPromptErrors,
  parseStructuredPromptForm,
} from './prompt-structured-content.js';
import { AdminAuditTimelineStore } from './audit-timeline.js';
import { ValuesJournalStore } from '../../values/store.js';
import {
  resolveLegacyValuesJournalPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../session/compaction-audit.js';
import * as tpl from './templates.js';
import { toErrorMessage } from '../../utils/errors.js';
import { parsePositiveInteger } from './utils.js';
import {
  buildRelatedConversationChannelMap as buildRelatedConversationChannelMapFromContacts,
  getContactIdentityLinks as getContactIdentityLinksFromContact,
  getLinkedContactForSession as getLinkedContactForSessionFromContacts,
  getPersistedConversationChannels as getPersistedConversationChannelsFromContact,
  normalizeSessionChannelType as normalizeSessionChannelTypeFromId,
  sessionMatchesConversationChannel as sessionMatchesConversationChannelFromId,
  sessionMatchesIdentity as sessionMatchesIdentityFromId,
  splitSessionChannelId as splitSessionChannelIdFromSession,
  type ContactConversationChannelView,
  type ContactIdentityLinkView,
} from './services/contact-session-linker.js';
import {
  registerAuditTimelineSources,
  type ActiveToolInvocation,
} from './services/audit-event-collector.js';

interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}
const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;

export class LegacyAdminHandlers {
  private memoryStore: MemoryStore;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private scheduler: Scheduler;
  private shardManager: ShardManager;
  private eventBus: EventBus;
  private config: SubstrateConfig;
  private modelDiscovery: ModelDiscovery | null;
  private contactStore: ContactStore | null;
  private promptStore: PromptLayerStore | null;
  private promptRegistry: PromptRegistryStore | null;
  private skillsRuntime: SkillsRuntime | null;
  private confirmationQueueApi: ConfirmationQueueAdminApi | null;
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
  private auditTimeline = new AdminAuditTimelineStore();
  private valuesJournal: ValuesJournalStore;
  private activeToolInvocations = new Map<string, ActiveToolInvocation>();

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
    cardVersionStore?: CharacterCardVersionStore | null;
    skillsRuntime?: SkillsRuntime | null;
    confirmationQueueApi?: ConfirmationQueueAdminApi | null;
    apiBaseUrl?: string;
    apiHost?: string;
    apiPort?: number;
  }) {
    this.memoryStore = deps.memoryStore;
    this.sessionStore = deps.sessionStore;
    this.sessionManager = deps.sessionManager;
    this.scheduler = deps.scheduler;
    this.shardManager = deps.shardManager;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.modelDiscovery = deps.modelDiscovery ?? null;
    this.contactStore = deps.contactStore ?? null;
    this.promptStore = deps.promptStore ?? null;
    this.promptRegistry = deps.promptRegistry ?? null;
    this.skillsRuntime = deps.skillsRuntime ?? null;
    this.confirmationQueueApi = deps.confirmationQueueApi ?? null;
    this.valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(this.config.dataDir), {
      legacyFilePaths: [resolveLegacyValuesJournalPath(this.config.dataDir)],
    });

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

    this.registerAuditTimelineSources();
  }

  private registerAuditTimelineSources(): void {
    registerAuditTimelineSources({
      eventBus: this.eventBus,
      activeToolInvocations: this.activeToolInvocations,
      appendAuditTimelineEntry: (actionType, decision, narrative, details = [], actor) => {
        this.appendAuditTimelineEntry(actionType, decision, narrative, details, actor);
      },
    });
  }

  appendAuditTimelineEntry(
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
    actor?: AdminAuditActor,
  ): void {
    const detailText = details.filter((value): value is string => Boolean(value && value.trim())).join(' • ');
    const resolvedActor = actor ?? (actionType === 'identity_edit' ? 'operator' : undefined);
    this.auditTimeline.append({
      actionType,
      decision,
      narrative,
      details: detailText || undefined,
      actor: resolvedActor,
    });
  }

  private injectPromptEditSystemNote(note: string): void {
    const targetChannels = [...new Set(
      this.sessionStore
        .listChannels()
        .map(channel => channel.channelId)
        .filter(channelId => !channelId.startsWith('internal:') && !channelId.startsWith('shard:')),
    )];

    for (const channelId of targetChannels) {
      this.sessionManager.appendSystemNote(channelId, note);
    }
  }

  // ── Login ──

  loginPage(error?: string): string {
    return tpl.loginPage(error);
  }

  // ── Memory ──

  private buildContactSummaryMap(): Map<string, { id: string; displayName: string }> {
    if (!this.contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    for (const contact of this.contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  private resolveMemoryListPagination(params?: URLSearchParams): {
    limit: number;
    offset: number;
  } {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_MEMORY_LIST_LIMIT,
      1,
      MAX_MEMORY_LIST_LIMIT,
    );
    const offset = parsePositiveInteger(params?.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    return { limit, offset };
  }

  // ── Sessions ──

  private normalizeSessionChannelType(channelId: string): string {
    return normalizeSessionChannelTypeFromId(channelId);
  }

  private sessionMatchesConversationChannel(
    sessionChannelId: string,
    conversationChannel: ContactConversationChannelView,
  ): boolean {
    return sessionMatchesConversationChannelFromId(sessionChannelId, conversationChannel);
  }

  private getLinkedContactForSession(channelId: string, contacts: Contact[]): Contact | undefined {
    return getLinkedContactForSessionFromContacts({
      channelId,
      contacts,
      sessionStore: this.sessionStore,
      contactStore: this.contactStore,
    });
  }

  private buildCompactionAuditViews(channelId: string): CompactionAuditView[] {
    return this.sessionStore
      .getCompactionSummaries(channelId)
      .slice()
      .sort((left, right) => right.id - left.id)
      .map(summary => this.verifyCompactionSummary(channelId, summary));
  }

  private verifyCompactionSummary(channelId: string, summary: CompactionSummary): CompactionAuditView {
    const parsed = parseCompactionSourceHashTag(summary.summary);
    if (!parsed) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: null,
        sourceFirstMessageId: null,
        sourceLastMessageId: null,
        sourceMessageCount: null,
        verification: 'missing_hash',
        verificationDetail: 'Source hash metadata is missing in this compaction summary.',
      };
    }

    const sourceEntries = this.sessionStore.getEntriesInRange(
      channelId,
      parsed.firstMessageId,
      parsed.lastMessageId,
    );
    const firstId = sourceEntries[0]?.id ?? null;
    const lastId = sourceEntries[sourceEntries.length - 1]?.id ?? null;
    if (sourceEntries.length !== parsed.messageCount || firstId !== parsed.firstMessageId || lastId !== parsed.lastMessageId) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: parsed.sha256,
        sourceFirstMessageId: parsed.firstMessageId,
        sourceLastMessageId: parsed.lastMessageId,
        sourceMessageCount: parsed.messageCount,
        verification: 'missing_source',
        verificationDetail: `JSONL source block mismatch: expected ids ${parsed.firstMessageId}-${parsed.lastMessageId} (${parsed.messageCount} entries), found ${sourceEntries.length} entries.`,
      };
    }

    const computedHash = computeCompactionSourceSha256(buildCompactionSourceBlock(sourceEntries));
    if (computedHash !== parsed.sha256) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: parsed.sha256,
        sourceFirstMessageId: parsed.firstMessageId,
        sourceLastMessageId: parsed.lastMessageId,
        sourceMessageCount: parsed.messageCount,
        verification: 'mismatch',
        verificationDetail: `Hash mismatch: summary=${parsed.sha256} jsonl=${computedHash}.`,
      };
    }

    return {
      id: summary.id,
      createdAt: summary.createdAt,
      coveredUpTo: summary.coveredUpTo,
      summary: summary.summary,
      sourceHash: parsed.sha256,
      sourceFirstMessageId: parsed.firstMessageId,
      sourceLastMessageId: parsed.lastMessageId,
      sourceMessageCount: parsed.messageCount,
      verification: 'verified',
      verificationDetail: 'Verified against JSONL source block.',
    };
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
      importProcessingLocalApiKey: process.env.IMPORT_PROCESSING_LOCAL_API_KEY ? 'configured' : 'not set',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not set',
    };
  }

  private loadSettingsConfigEditors(): SettingsConfigEditors {
    return {
      models: loadModelsConfig(this.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
        defaultContextWindow: this.config.defaultContextWindow,
      }),
      skills: loadSkillsConfig(this.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      scheduler: loadSchedulerConfig(this.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      trustPolicy: loadTrustPolicyConfig(this.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      capabilities: loadCapabilityTierConfig(this.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
    };
  }

  private parseConfigJsonBody(body: string): unknown {
    const params = new URLSearchParams(body);
    const configJson = (params.get('configJson') ?? '').trim();
    if (!configJson) {
      throw new Error('configJson is required');
    }

    try {
      return JSON.parse(configJson);
    } catch {
      throw new Error('configJson must be valid JSON');
    }
  }

  private formatConfigError(error: unknown): string {
    return toErrorMessage(error);
  }

  primerPage(): string {
    return tpl.layout('Garden Primer', tpl.primerPage(), 'primer');
  }

  private async renderConfirmationQueueFragment(
    message?: string,
    isError = false,
  ): Promise<string> {
    if (!this.confirmationQueueApi) {
      return tpl.confirmationQueueFragment({
        entries: [],
        available: false,
        message: message ?? 'Confirmation queue is unavailable (gateway integration not configured).',
        isError: true,
      });
    }

    try {
      const list = await this.confirmationQueueApi.listConfirmationQueue();
      return tpl.confirmationQueueFragment({
        entries: list.entries,
        available: true,
        message,
        isError,
      });
    } catch (error) {
      const details = toErrorMessage(error);
      return tpl.confirmationQueueFragment({
        entries: [],
        available: true,
        message: message ?? `Unable to load confirmation queue: ${details}`,
        isError: true,
      });
    }
  }

  // ── Contacts ──

  private getContactNickname(contact: Contact): string | undefined {
    const nickname = (contact as Contact & { nickname?: string }).nickname;
    if (typeof nickname !== 'string') return undefined;
    const trimmed = nickname.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private getContactIdentityLinks(contact: Contact): ContactIdentityLinkView[] {
    return getContactIdentityLinksFromContact(contact);
  }

  private getPersistedConversationChannels(contact: Contact): ContactConversationChannelView[] {
    return getPersistedConversationChannelsFromContact(contact);
  }

  private splitSessionChannelId(channelId: string): { channel: string; channelId: string } {
    return splitSessionChannelIdFromSession(channelId);
  }

  private sessionMatchesIdentity(sessionChannelId: string, identity: ContactIdentityLinkView): boolean {
    return sessionMatchesIdentityFromId(sessionChannelId, identity);
  }

  private buildRelatedConversationChannelMap(contacts: Contact[]): Map<string, ContactConversationChannelView[]> {
    return buildRelatedConversationChannelMapFromContacts({
      contacts,
      sessionStore: this.sessionStore,
    });
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

  private normalizeContactMutationAuditField(value: string | null): ContactMutationAuditField | undefined {
    const trimmed = value?.trim();
    switch (trimmed) {
      case 'trust_level':
      case 'notes':
        return trimmed;
      default:
        return undefined;
    }
  }

  private parseContactMutationAuditQuery(params?: URLSearchParams): ContactMutationAuditQuery {
    const rawLimit = params?.get('limit');
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : 25;

    const contactId = params?.get('contactId')?.trim() || undefined;
    const actor = params?.get('actor')?.trim() || undefined;
    const field = this.normalizeContactMutationAuditField(params?.get('field') ?? null);

    return {
      contactId,
      actor,
      field,
      limit,
    };
  }

  private listContactMutationAuditEntries(query: ContactMutationAuditQuery): ContactMutationAuditEntry[] {
    if (!this.contactStore) return [];
    const storeWithAuditList = this.contactStore as ContactStore & {
      listMutationAuditEntries?: (auditQuery?: ContactMutationAuditQuery) => ContactMutationAuditEntry[];
    };
    if (typeof storeWithAuditList.listMutationAuditEntries !== 'function') return [];
    return storeWithAuditList.listMutationAuditEntries(query);
  }

  // ── Prompt Stack ──

  private resolvePromptLayerContent(params: URLSearchParams): { content: string } | { error: string } {
    if (containsStructuredPromptSections(params)) {
      const structured = parseStructuredPromptForm(params);
      if (!structured.ok) return { error: structured.error };
      return { content: structured.content };
    }

    const content = params.get('content') ?? '';
    const malformedStructuredErrors = getMalformedStructuredPromptErrors(content);
    if (malformedStructuredErrors.length > 0) {
      return { error: `Malformed structured prompt content: ${malformedStructuredErrors.join(' ')}` };
    }

    return { content };
  }

  private resolvePromptLayerMetadata(
    params: URLSearchParams,
  ): { metadata: PromptLayerMetadataUpdate } | { error: string } {
    const metadata: PromptLayerMetadataUpdate = {};

    if (params.has('identifier')) {
      const rawIdentifier = params.get('identifier');
      metadata.identifier = rawIdentifier?.trim() ? rawIdentifier.trim() : undefined;
    }

    if (params.has('role')) {
      const rawRole = params.get('role');
      const role = rawRole?.trim() ?? '';
      if (role.length === 0) {
        metadata.role = undefined;
      } else if (!PROMPT_LAYER_ROLES.includes(role as PromptLayerRole)) {
        return { error: `role must be one of: ${PROMPT_LAYER_ROLES.join(', ')}` };
      } else {
        metadata.role = role as PromptLayerRole;
      }
    }

    if (params.has('promptOrder')) {
      const rawPromptOrder = params.get('promptOrder');
      const value = rawPromptOrder?.trim() ?? '';
      if (value.length === 0) {
        metadata.promptOrder = undefined;
      } else if (!/^\d+$/.test(value)) {
        return { error: 'promptOrder must be an integer >= 0' };
      } else {
        metadata.promptOrder = parseInt(value, 10);
      }
    }

    return { metadata };
  }

}
