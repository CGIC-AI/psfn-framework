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

  async settingsPage(): Promise<string> {
    const envInfo = this.getEnvInfo();
    const models = this.modelDiscovery
      ? await this.modelDiscovery.getAvailableModels().catch(() => undefined)
      : undefined;
    const configEditors = this.loadSettingsConfigEditors();
    return tpl.layout('Settings', tpl.settingsPage(this.config, envInfo, configEditors, models), 'settings');
  }

  skillsPage(): string {
    if (!this.skillsRuntime) {
      return tpl.layout('Skills', '<div class="empty">Skills runtime not configured</div>', 'skills');
    }
    const snapshot = this.skillsRuntime.getSnapshot();
    return tpl.layout('Skills', tpl.skillsPage(snapshot), 'skills');
  }

  updateSettings(body: string): string {
    const params = new URLSearchParams(body);
    const capabilityTierInput = (params.get('capabilityTier') ?? '').trim();
    if (capabilityTierInput && !isCapabilityTier(capabilityTierInput)) {
      return tpl.settingsFormResult(
        false,
        `capabilityTier must be one of: ${CAPABILITY_TIER_VALUES.join(', ')}`,
      );
    }
    const [settings, errors] = parseSettingsForm(params);

    if (errors.length > 0) {
      return tpl.settingsFormResult(false, errors.join('; '));
    }

    // Load existing saved settings, merge, save, and apply to live config
    const existing = loadSettings(this.config.dataDir);
    const merged = normalizeEditableSettings(
      { ...existing, ...settings },
      { defaultContextWindow: this.config.defaultContextWindow },
    );
    saveSettings(this.config.dataDir, merged);
    applySettings(this.config, merged);
    if (this.config.modelCatalog && this.config.modelRoleAssignments) {
      try {
        saveModelsConfig(
          this.config.dataDir,
          {
            modelCatalog: this.config.modelCatalog,
            modelRoleAssignments: this.config.modelRoleAssignments,
          },
          { defaultContextWindow: this.config.defaultContextWindow },
        );
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but models config write failed: ${message}`);
      }
    }
    try {
      this.config.runtimeHooks?.refreshModels?.();
    } catch {
      // Keep settings save successful even if runtime model refresh fails.
      // Next turn will still re-attempt refresh through SubstrateAgent drift detection.
    }

    if (capabilityTierInput) {
      try {
        const current = loadCapabilityTierConfig(this.config.dataDir, {
          seedDir: process.env.CONFIG_DIR,
        });

        // Parse custom token grants from form checkboxes
        const customTokens: CapabilityToken[] = [];
        if (capabilityTierInput === 'custom') {
          for (const rawToken of params.getAll('customTokens')) {
            const token = rawToken.trim();
            if (token && isCapabilityToken(token)) {
              customTokens.push(token);
            }
          }
        }

        const saved = saveCapabilityTierConfig(this.config.dataDir, {
          ...current,
          tier: capabilityTierInput,
          customTokens: capabilityTierInput === 'custom' ? customTokens : current.customTokens,
        });
        this.config.capabilityTier = saved.tier;
        this.config.runtimeHooks?.refreshCapabilities?.();
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but capability tier update failed: ${message}`);
      }
    }

    const changedFields = Object.keys(settings).sort();
    if (capabilityTierInput) {
      changedFields.push('capabilityTier');
    }
    this.appendAuditTimelineEntry(
      'settings_change',
      'allowed',
      'Operator updated runtime settings.',
      [
        changedFields.length > 0 ? `fields=${changedFields.join(',')}` : null,
      ],
      'operator',
    );

    return tpl.settingsFormResult(true, 'Settings saved');
  }

  modelsConfigJson(): string {
    const config = loadModelsConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
      defaultContextWindow: this.config.defaultContextWindow,
    });
    return JSON.stringify(config, null, 2);
  }

  updateModelsConfig(body: string): string {
    try {
      const payload = this.parseConfigJsonBody(body);
      const saved = saveModelsConfig(
        this.config.dataDir,
        payload,
        { defaultContextWindow: this.config.defaultContextWindow },
      );
      applySettings(this.config, saved);
      try {
        this.config.runtimeHooks?.refreshModels?.();
      } catch {
        // Preserve successful save result even when runtime model refresh fails.
      }
      return tpl.settingsFormResult(true, 'models.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  skillsConfigJson(): string {
    const config = loadSkillsConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSkillsConfig(body: string): string {
    try {
      const payload = this.parseConfigJsonBody(body);
      saveSkillsConfig(this.config.dataDir, payload);
      this.skillsRuntime?.invalidate();
      return tpl.settingsFormResult(true, 'skills.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  schedulerConfigJson(): string {
    const config = loadSchedulerConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSchedulerConfig(body: string): string {
    try {
      const payload = this.parseConfigJsonBody(body);
      saveSchedulerConfig(this.config.dataDir, payload);
      const resolved = resolveRuntimeSchedulerConfig({
        dataDir: this.config.dataDir,
        seedDir: process.env.CONFIG_DIR,
      });

      this.config.maintenanceIntervalMs = resolved.salienceDecayIntervalMs;

      const schedulerWithConfig = this.scheduler as Scheduler & {
        updateConfig?: (config: { tickIntervalMs?: number; heartbeatIntervalMs?: number }) => void;
      };
      schedulerWithConfig.updateConfig?.({
        tickIntervalMs: resolved.tickIntervalMs,
        heartbeatIntervalMs: resolved.heartbeatIntervalMs,
      });
      this.scheduler.updateTask('heartbeat', { intervalMs: resolved.heartbeatIntervalMs });
      this.scheduler.updateTask('salience-decay', { intervalMs: resolved.salienceDecayIntervalMs });

      return tpl.settingsFormResult(true, 'scheduler.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  trustPolicyConfigJson(): string {
    const config = loadTrustPolicyConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateTrustPolicyConfig(body: string): string {
    try {
      const payload = this.parseConfigJsonBody(body);
      const saved = saveTrustPolicyConfig(this.config.dataDir, payload);
      setRuntimeTrustPolicy(saved);
      return tpl.settingsFormResult(true, 'trust-policy.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  capabilitiesConfigJson(): string {
    const config = loadCapabilityTierConfig(this.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateCapabilitiesConfig(body: string): string {
    try {
      const payload = this.parseConfigJsonBody(body);
      const saved = saveCapabilityTierConfig(this.config.dataDir, payload);
      this.config.capabilityTier = saved.tier;
      this.config.runtimeHooks?.refreshCapabilities?.();
      return tpl.settingsFormResult(true, 'capability-tier.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
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

  contactsPage(): string {
    if (!this.contactStore) {
      return tpl.layout('Garden Visitors', '<div class="empty">Contact store not available</div>', 'contacts');
    }
    const contacts = this.contactStore.listAll();
    const profileMap = new Map(
      this.memoryStore.listContactProfiles().map(profile => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.buildRelatedConversationChannelMap(contacts);
    const maybeVerificationLister = this.contactStore as ContactStore & {
      listIdentityLinkVerifications?: (limit?: number) => ContactIdentityLinkVerification[];
    };
    const verifications = typeof maybeVerificationLister.listIdentityLinkVerifications === 'function'
      ? maybeVerificationLister.listIdentityLinkVerifications(20)
      : [];
    const mutationAuditQuery = this.parseContactMutationAuditQuery();
    const mutationAudits = this.listContactMutationAuditEntries(mutationAuditQuery);
    return tpl.layout(
      'Garden Visitors',
      tpl.contactsPage(
        contacts,
        profileMap,
        relatedChannelMap,
        verifications,
        mutationAudits,
        mutationAuditQuery,
      ),
      'contacts',
    );
  }

  contactMutationAuditFragment(params?: URLSearchParams): string {
    const query = this.parseContactMutationAuditQuery(params);
    const entries = this.listContactMutationAuditEntries(query);
    return tpl.contactMutationAuditFragment(entries);
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
    const newChannelPrivacy = (newChannelPrivacyRaw || 'semi_private') as ChannelPrivacyLevel;
    const wantsNewChannelLink = newChannel.length > 0 || newChannelUserId.length > 0;
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

    if (wantsNewChannelLink && (!newChannel || !newChannelUserId)) {
      return tpl.settingsFormResult(false, 'To link a new channel, both channel and channel user ID are required');
    }

    if (wantsNewChannelLink && !CHANNEL_PRIVACY_LEVELS.includes(newChannelPrivacy)) {
      return tpl.settingsFormResult(false, `Invalid new channel privacy level: ${newChannelPrivacyRaw}`);
    }

    if (displayName !== contact.displayName || nickname !== currentNickname) {
      const updatedIdentity = this.updateIdentityProfile(contact, displayName, nickname);
      if (!updatedIdentity) {
        return tpl.settingsFormResult(false, 'Unable to update contact identity profile');
      }
    }

    if (trustLevel && trustLevel !== contact.trustLevel) {
      const updatedTrust = this.contactStore.setTrustLevel(contactId, trustLevel, 'admin:gui');
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
      this.contactStore.updateNotes(contactId, notes, 'admin:gui');
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

    if (wantsNewChannelLink && newChannel && newChannelUserId) {
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

    const identityTouched = (
      displayName !== contact.displayName
      || nickname !== currentNickname
      || channelPrivacyUpdates.length > 0
      || wantsNewChannelLink
    );
    if (identityTouched) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN updated identity details for contact "${updated.displayName}".`,
        [
          displayName !== contact.displayName ? `displayName=${updated.displayName}` : null,
          nickname !== currentNickname ? `nickname=${nickname ?? '(none)'}` : null,
          channelPrivacyUpdates.length > 0 ? `privacyUpdates=${channelPrivacyUpdates.length}` : null,
          wantsNewChannelLink ? `linked=${newChannel}:${newChannelUserId}` : null,
        ],
      );
    }

    // Return a fresh table row so htmx replaces the edit form
    const relatedChannels = this.buildRelatedConversationChannelMap([updated]).get(updated.id) ?? [];
    return tpl.contactRow(updated, this.memoryStore.getContactProfile(updated.id), relatedChannels);
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
    if (!this.promptStore) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt layer edit was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolved.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolved.error);
    }
    const resolvedMetadata = this.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit was denied: ${resolvedMetadata.error}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, resolvedMetadata.error);
    }
    try {
      const layer = this.promptStore.update(
        layerId,
        resolved.content,
        'admin',
        resolvedMetadata.metadata,
        'Admin prompt-layer edit via Garden UI',
      );
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN edited ${layer.type} prompt layer "${layer.name}".`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );
      this.injectPromptEditSystemNote(
        `Admin updated ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      return tpl.settingsFormResult(true, `Updated "${layer.name}" to v${layer.version}`);
    } catch (err) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt layer edit failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  updatePromptRegistry(body: string): string {
    if (!this.promptRegistry) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt registry edit was denied: prompt registry is not configured.',
      );
      return '<div class="form-error">Prompt registry not configured</div>';
    }
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const content = params.get('content') ?? '';
    try {
      const prompt = this.promptRegistry.update(key, content, 'admin');
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN edited static prompt "${prompt.key}".`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Updated "${prompt.key}" to v${prompt.version}`);
    } catch (err) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt registry edit failed: ${String(err)}`,
        [`key=${key}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  togglePromptLayer(body: string): string {
    if (!this.promptStore) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt toggle was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    try {
      this.promptStore.toggle(layerId);
      const layer = this.promptStore.getById(layerId);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN toggled prompt layer "${layer?.name ?? layerId}".`,
        [layer ? `enabled=${layer.enabled}` : null],
      );
      if (layer) {
        this.injectPromptEditSystemNote(
          `Admin toggled ${layer.type} prompt layer "${layer.name}" (${layer.enabled ? 'enabled' : 'disabled'}).`,
        );
      }
      // Return the full updated list for htmx swap
      const layers = this.promptStore.getAll();
      return tpl.promptLayersFragment(layers);
    } catch (err) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt toggle failed: ${String(err)}`,
        [`layerId=${layerId}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptLayer(body: string): string {
    if (!this.promptStore) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Prompt rollback was denied: prompt store is not configured.',
      );
      return '<div class="form-error">Prompt store not configured</div>';
    }
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const layer = this.promptStore.rollback(layerId, version);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled prompt layer "${layer.name}" back to v${version}.`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );
      this.injectPromptEditSystemNote(
        `Admin rolled back ${layer.type} prompt layer "${layer.name}" using v${version} content (now v${layer.version}).`,
      );
      return tpl.settingsFormResult(true, `Rolled back "${layer.name}" to content from v${version}`);
    } catch (err) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Prompt rollback failed: ${String(err)}`,
        [`layerId=${layerId}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  rollbackPromptRegistry(body: string): string {
    if (!this.promptRegistry) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Static prompt rollback was denied: prompt registry is not configured.',
      );
      return '<div class="form-error">Prompt registry not configured</div>';
    }
    const params = new URLSearchParams(body);
    const key = params.get('key') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const prompt = this.promptRegistry.rollback(key, version);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled static prompt "${prompt.key}" back to v${version}.`,
        [`version=${prompt.version}`],
      );
      return tpl.settingsFormResult(true, `Rolled back "${prompt.key}" to content from v${version}`);
    } catch (err) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Static prompt rollback failed: ${String(err)}`,
        [`key=${key}`, `version=${version}`],
      );
      return tpl.settingsFormResult(false, String(err));
    }
  }

  previewPromptLayerDiff(body: string): string {
    if (!this.promptStore) return '<div class="form-error">Prompt store not configured</div>';
    const params = new URLSearchParams(body);
    const layerId = params.get('layerId') ?? '';
    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) return tpl.settingsFormResult(false, resolved.error);
    const layer = this.promptStore.getById(layerId);
    if (!layer) return '<div class="form-error">Prompt layer not found</div>';
    return tpl.promptDiffFragment(layer.content, resolved.content);
  }
}
