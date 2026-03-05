// ── Admin Route Handlers ──
// Each method returns an HTML string (full page or fragment).

import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { CompactionSummary } from '../../session/types.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardManager } from '../../shards/manager.js';
import type { EventBus } from '../../event-bus.js';
import type { EmbeddingService } from '../../agent/contracts.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type {
  ThinkTraceView,
  ConfirmationQueueAdminApi,
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  CompactionAuditView,
} from './types.js';
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import type { Contact } from '../../contacts/types.js';
import type { SkillsRuntime } from '../../skills/runtime.js';
import { AdminAuditTimelineStore } from './audit-timeline.js';
import { ValuesJournalStore } from '../../values/store.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveLegacyValuesJournalPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../session/compaction-audit.js';
import * as tpl from './templates.js';
import {
  getLinkedContactForSession as getLinkedContactForSessionFromContacts,
} from './services/contact-session-linker.js';
import {
  registerAuditTimelineSources,
  type ActiveToolInvocation,
} from './services/audit-event-collector.js';

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
    const companionDataDir = resolveConfiguredCompanionDataDir(this.config);
    this.valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
      legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
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

  // ── Login ──

  loginPage(error?: string): string {
    return tpl.loginPage(error);
  }

  // ── Sessions ──

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

  primerPage(): string {
    return tpl.layout('Garden Primer', tpl.primerPage(), 'primer');
  }
}
