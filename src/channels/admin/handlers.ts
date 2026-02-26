// ── Admin Route Handlers ──
// Each method returns an HTML string (full page or fragment).

import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore } from '../../memory/store.js';
import { MemoryWriter, type MemoryWriteOptions } from '../../memory/writer.js';
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
  AdminAuditDecision,
  AdminChatDebugCategory,
  AdminChatDebugEventPayload,
  AdminChatDebugStreamOptions,
  AdminChatDebugDetailValue,
  CompactionAuditView,
} from './types.js';
import type { ModelDiscovery } from '../../llm/discovery.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerMetadataUpdate, PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import {
  importCharacterCardFromPath,
  persistExtractedCharacterAssets,
  writeNormalizedCharacterCard,
  type CharacterMemorySeed,
} from '../../identity/importer.js';
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
import {
  MEMORY_CONFIG,
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  estimateImportedMemoryCriticality,
  inferImportedMemoryType,
  initializeImportedMemorySalience,
  type MemoryType,
  type SensitivityLevel,
} from '../../memory/types.js';
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
import {
  AdminChatBootstrapService,
  type AdminChatBootstrapResponse,
  type AdminChatBootstrapUpdateInput,
} from './chat/index.js';
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
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../session/compaction-audit.js';
import type {
  IdentityIntakeChatChunk,
  IdentityIntakeCardMutation,
  IdentityIntakeFlash,
  IdentityIntakeItemStatus,
  IdentityIntakeMemoryItem,
  IdentityIntakeReviewState,
  IdentityIntakeSourceSummary,
} from './templates/identity.js';
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

interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}

interface ActiveToolInvocation {
  toolName: string;
  channelId: string;
  startedAt: number;
}

type ChatDebugEventName =
  | 'agent.turn.start'
  | 'agent.turn.stage'
  | 'agent.turn.end'
  | 'agent.stream.thinking'
  | 'agent.stream.delta'
  | 'agent.tool.start'
  | 'agent.tool.end'
  | 'memory.extraction.start'
  | 'memory.extraction.end'
  | 'memory.retrieval'
  | 'agent.error'
  | 'channel.voice.error'
  | 'voice.turn.error'
  | 'wyoming.session.start'
  | 'wyoming.session.end'
  | 'wyoming.connection.error'
  | 'wyoming.policy.violation'
  | 'wyoming.audit.summary'
  | 'system.error';

const CHAT_DEBUG_EVENTS: ChatDebugEventName[] = [
  'agent.turn.start',
  'agent.turn.stage',
  'agent.turn.end',
  'agent.stream.thinking',
  'agent.stream.delta',
  'agent.tool.start',
  'agent.tool.end',
  'memory.extraction.start',
  'memory.extraction.end',
  'memory.retrieval',
  'agent.error',
  'channel.voice.error',
  'voice.turn.error',
  'wyoming.session.start',
  'wyoming.session.end',
  'wyoming.connection.error',
  'wyoming.policy.violation',
  'wyoming.audit.summary',
  'system.error',
];

const AGENT_IDENTITY_EDIT_TOOLS = new Set([
  'prompt_layer_update',
  'prompt_layer_toggle',
  'character_card_update',
]);

const MAX_DEBUG_TEXT_CHARS = 280;
const MAX_DEBUG_MESSAGE_CHARS = 220;
const MAX_DEBUG_DETAILS = 6;
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;
const DEFAULT_CHAT_CHUNK_TARGET_TOKENS = 50_000;
const MIN_CHAT_CHUNK_TARGET_TOKENS = 1_000;
const MAX_CHAT_CHUNK_TARGET_TOKENS = 200_000;
const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;

const INTAKE_CARD_DIFF_FIELDS: Array<{ key: keyof CharacterCardV2['data']; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'first_mes', label: 'First Message' },
  { key: 'mes_example', label: 'Message Example' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History Instructions' },
  { key: 'tags', label: 'Tags' },
  { key: 'creator', label: 'Creator' },
  { key: 'creator_notes', label: 'Creator Notes' },
];

type IntakeStageStatus = 'pending' | 'partially_committed' | 'committed' | 'rejected';

interface StagedIntakeSource {
  kind: IdentityIntakeSourceSummary['kind'];
  path: string;
  itemCount: number;
  note?: string;
}

interface StagedIntakeCardMutation {
  sourcePath: string;
  containerFormat: string;
  spec: string;
  warnings: string[];
  status: IdentityIntakeItemStatus;
  rows: IdentityIntakeCardMutation['rows'];
  importedCard: CharacterCardV2;
}

interface StagedIntakeChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  authorId?: string;
  authorName?: string;
}

interface StagedIntakeChatMutation {
  channelId: string;
  chunkTargetTokens: number;
  messages: StagedIntakeChatMessage[];
  chunks: IdentityIntakeChatChunk[];
}

interface StagedIntakeMemoryMutation extends Omit<IdentityIntakeMemoryItem, 'textPreview'> {
  text: string;
}

interface StagedIdentityIntake {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: IntakeStageStatus;
  sources: StagedIntakeSource[];
  cardMutation: StagedIntakeCardMutation | null;
  chatMutation: StagedIntakeChatMutation | null;
  memoryMutations: StagedIntakeMemoryMutation[];
}

interface IntakeFlash {
  kind: IdentityIntakeFlash['kind'];
  message: string;
}

interface ParsedRawMemoryItem {
  text: string;
  type: MemoryType;
  importance: number;
  salience: number;
  criticality: number;
  tags: string[];
  provenanceRefs: string[];
  sensitivity: SensitivityLevel;
  contactId?: string;
  extractedAt?: number;
  lastAccessed?: number;
  relationshipTypeHint?: RelationshipType;
}

function truncateDebugText(value: unknown, maxChars = MAX_DEBUG_TEXT_CHARS): string {
  if (typeof value !== 'string') return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function toDebugDetailValue(value: unknown): AdminChatDebugDetailValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return truncateDebugText(value, 160);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (value instanceof Error) return truncateDebugText(value.message, 160);
  if (Array.isArray(value)) return `[${value.length} items]`;
  return undefined;
}

function clampUnit(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSessionRole(value: unknown): 'user' | 'assistant' | 'system' {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'assistant' || text === 'bot' || text === 'ai' || text === 'character' || text === 'char') {
    return 'assistant';
  }
  if (text === 'system') return 'system';
  return 'user';
}

function normalizeSensitivity(value: unknown): SensitivityLevel {
  if (typeof value !== 'string') return 'personal';
  const normalized = value.trim().toLowerCase();
  return VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)
    ? normalized as SensitivityLevel
    : 'personal';
}

function estimateTokens(text: string): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / 4));
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsedNumber = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsedNumber) && parsedNumber > 0) return parsedNumber;
      const parsedDate = Date.parse(trimmed);
      if (Number.isFinite(parsedDate) && parsedDate > 0) return parsedDate;
    }
  }
  return fallback;
}

function uniqueLowercase(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) out.add(normalized);
  }
  return [...out];
}

const RELATIONSHIP_TYPE_HINTS: ReadonlyArray<{ type: RelationshipType; hints: readonly string[] }> = [
  { type: 'partner', hints: ['partner', 'spouse', 'wife', 'husband', 'boyfriend', 'girlfriend'] },
  { type: 'family', hints: ['family', 'mother', 'father', 'sister', 'brother', 'parent', 'child'] },
  { type: 'friend', hints: ['friend', 'bestie', 'buddy'] },
  { type: 'acquaintance', hints: ['acquaintance', 'coworker', 'colleague', 'neighbor'] },
  { type: 'ai_companion', hints: ['ai_companion', 'companion'] },
];

const RELATIONSHIP_STRENGTH: Record<RelationshipType, number> = {
  stranger: 0,
  acquaintance: 1,
  friend: 2,
  family: 3,
  ai_companion: 3,
  partner: 4,
};

function normalizeProvenanceRefs(values: readonly string[], fallback?: string): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const normalized = raw.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback && normalizedFallback.length > 0) {
    out.add(normalizedFallback);
  }
  return [...out];
}

function parseProvenanceRefs(entry: Record<string, unknown>, fallbackRef: string): string[] {
  const refs = [
    ...toStringArray(entry.provenanceRefs),
    ...toStringArray(entry.provenance),
    ...toStringArray(entry.sources),
  ];
  const source = toNonEmptyString(entry.sourceRef)
    ?? toNonEmptyString(entry.source)
    ?? toNonEmptyString(entry.origin);
  if (source) refs.push(source);
  return normalizeProvenanceRefs(refs, fallbackRef);
}

function buildMemoryDedupKey(text: string, type: MemoryType, contactId?: string): string {
  const normalizedText = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const normalizedContact = contactId?.trim().toLowerCase() ?? '';
  return `${type}|${normalizedContact}|${normalizedText}`;
}

function inferRelationshipTypeHint(input: {
  explicitValue?: unknown;
  text: string;
  tags: readonly string[];
  type: MemoryType;
}): RelationshipType | undefined {
  const explicit = toNonEmptyString(input.explicitValue)?.toLowerCase();
  if (explicit && VALID_RELATIONSHIP_TYPES.includes(explicit as RelationshipType)) {
    return explicit as RelationshipType;
  }
  if (input.type !== 'relational') return undefined;

  const corpus = `${input.text.toLowerCase()} ${input.tags.join(' ')}`;
  for (const entry of RELATIONSHIP_TYPE_HINTS) {
    if (entry.hints.some(hint => corpus.includes(hint))) {
      return entry.type;
    }
  }
  return undefined;
}

function shouldPromoteRelationship(existing: RelationshipType, candidate: RelationshipType): boolean {
  return RELATIONSHIP_STRENGTH[candidate] > RELATIONSHIP_STRENGTH[existing];
}

function normalizeCardFieldValue(card: CharacterCardV2, key: keyof CharacterCardV2['data']): string {
  if (key === 'tags') return card.data.tags.join(', ');
  const value = card.data[key];
  return typeof value === 'string' ? value : '';
}

export class AdminHandlers {
  private memoryStore: MemoryStore;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private scheduler: Scheduler;
  private shardManager: ShardManager;
  private eventBus: EventBus;
  private embeddingService: EmbeddingService | null;
  private importMemoryWriter: MemoryWriter | null;
  private characterCard: CharacterCardV2;
  private config: SubstrateConfig;
  private modelDiscovery: ModelDiscovery | null;
  private contactStore: ContactStore | null;
  private promptStore: PromptLayerStore | null;
  private promptRegistry: PromptRegistryStore | null;
  private cardVersionStore: CharacterCardVersionStore | null;
  private skillsRuntime: SkillsRuntime | null;
  private confirmationQueueApi: ConfirmationQueueAdminApi | null;
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
  private chatDebugCounter = 0;
  private auditTimeline = new AdminAuditTimelineStore();
  private valuesJournal: ValuesJournalStore;
  private activeToolInvocations = new Map<string, ActiveToolInvocation>();
  private stagedIntake: StagedIdentityIntake | null = null;

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
  }) {
    this.memoryStore = deps.memoryStore;
    this.sessionStore = deps.sessionStore;
    this.sessionManager = deps.sessionManager;
    this.scheduler = deps.scheduler;
    this.shardManager = deps.shardManager;
    this.eventBus = deps.eventBus;
    this.embeddingService = deps.embeddingService;
    this.importMemoryWriter = this.embeddingService
      ? new MemoryWriter(this.memoryStore, this.embeddingService)
      : null;
    this.characterCard = deps.characterCard;
    this.config = deps.config;
    this.modelDiscovery = deps.modelDiscovery ?? null;
    this.contactStore = deps.contactStore ?? null;
    this.promptStore = deps.promptStore ?? null;
    this.promptRegistry = deps.promptRegistry ?? null;
    this.cardVersionStore = deps.cardVersionStore ?? null;
    this.skillsRuntime = deps.skillsRuntime ?? null;
    this.confirmationQueueApi = deps.confirmationQueueApi ?? null;
    this.chatBootstrapService = new AdminChatBootstrapService(this.contactStore, {
      apiBaseUrl: deps.apiBaseUrl,
    });
    this.valuesJournal = new ValuesJournalStore(join(this.config.dataDir, 'values.jsonl'));

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
    this.eventBus.on('agent.tool.start', ({ toolCallId, toolName, channelId }) => {
      this.activeToolInvocations.set(toolCallId, {
        toolName,
        channelId,
        startedAt: Date.now(),
      });
    });

    this.eventBus.on('agent.tool.end', ({ toolCallId, toolName, channelId, isError, shardId }) => {
      const active = this.activeToolInvocations.get(toolCallId);
      if (active) {
        this.activeToolInvocations.delete(toolCallId);
      }
      const durationMs = active ? Math.max(0, Date.now() - active.startedAt) : null;
      const decision: AdminAuditDecision = isError ? 'denied' : 'allowed';
      const toolLabel = active?.toolName ?? toolName;
      const channelLabel = active?.channelId ?? channelId;
      this.appendAuditTimelineEntry(
        'tool_invocation',
        decision,
        isError
          ? `PSFN attempted tool "${toolLabel}" in ${channelLabel}, but it failed.`
          : `PSFN completed tool "${toolLabel}" in ${channelLabel}.`,
        [
          `callId=${toolCallId}`,
          shardId ? `shard=${shardId}` : null,
          durationMs !== null ? `durationMs=${durationMs}` : null,
        ],
      );

      if (AGENT_IDENTITY_EDIT_TOOLS.has(toolLabel)) {
        this.appendAuditTimelineEntry(
          'identity_edit',
          decision,
          isError
            ? `PSFN attempted identity edit via "${toolLabel}" in ${channelLabel}, but it failed.`
            : `PSFN edited identity via "${toolLabel}" in ${channelLabel}.`,
          [
            `callId=${toolCallId}`,
            shardId ? `shard=${shardId}` : null,
            durationMs !== null ? `durationMs=${durationMs}` : null,
          ],
        );
      }
    });

    this.eventBus.on('memory.extraction.end', (event) => {
      const writeCount = event.writeCount ?? 0;
      const deduplicatedCount = event.deduplicatedCount ?? 0;
      const supersededCount = event.supersededCount ?? 0;
      if (writeCount <= 0 && deduplicatedCount <= 0 && supersededCount <= 0) return;
      const decision: AdminAuditDecision = writeCount > 0 ? 'allowed' : 'denied';
      this.appendAuditTimelineEntry(
        'memory_mutation',
        decision,
        writeCount > 0
          ? `PSFN mutated memory in ${event.channelId}: wrote ${writeCount} memory entries.`
          : `PSFN attempted a memory mutation in ${event.channelId}, but no entries were written.`,
        [
          `accepted=${event.acceptedCount ?? 0}`,
          `rejected=${event.rejectedCount ?? 0}`,
          `deduplicated=${deduplicatedCount}`,
          `superseded=${supersededCount}`,
        ],
      );
    });

    this.eventBus.on('message.sent', ({ response }) => {
      this.appendAuditTimelineEntry(
        'external_action',
        'allowed',
        `PSFN sent an external response to ${response.channelId}.`,
        [
          `model=${response.metadata.model}`,
          `durationMs=${response.metadata.durationMs}`,
        ],
      );
    });

    this.eventBus.on('broadcast.approval.required', (event) => {
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Broadcast draft in ${event.channelId} was held for operator approval.`,
        [
          `scope=${event.visibilityScope}`,
          `signals=${event.signals.join(',') || 'none'}`,
          `draftLength=${event.draftLength}`,
        ],
      );
    });

    this.eventBus.on('broadcast.provenance', (event) => {
      this.appendAuditTimelineEntry(
        'external_action',
        event.risky && !event.operatorApproval ? 'denied' : 'allowed',
        `Broadcast provenance logged for ${event.channelId}.`,
        [
          `scope=${event.visibilityScope}`,
          `signals=${event.signals.join(',') || 'none'}`,
          `provenanceRefs=${event.provenanceRefs.length}`,
          `contextMessages=${event.contextMessageCount}`,
          `memoryContextChars=${event.memoryContextChars}`,
        ],
      );
    });

    this.eventBus.on('external.telemetry.ingested', ({ event }) => {
      this.appendAuditTimelineEntry(
        'external_action',
        'allowed',
        `External telemetry "${event.eventType}" from ${event.source} was ingested.`,
        [
          event.channelId ? `channelId=${event.channelId}` : null,
          event.scope ? `scope=${event.scope}` : null,
          `eventId=${event.id}`,
        ],
      );
    });

    this.eventBus.on('wyoming.session.start', (event) => {
      this.appendAuditTimelineEntry(
        'external_action',
        'allowed',
        `Wyoming session "${event.sessionId}" opened on ${event.connectionId}.`,
        [
          `activeSessions=${event.activeSessions}`,
          `maxSessions=${event.maxSessions}`,
        ],
      );
    });

    this.eventBus.on('wyoming.session.end', (event) => {
      const deniedReason = event.reason.includes('policy')
        || event.reason.includes('error')
        || event.reason.includes('timeout');
      this.appendAuditTimelineEntry(
        'external_action',
        deniedReason ? 'denied' : 'allowed',
        deniedReason
          ? `Wyoming session "${event.sessionId}" ended with policy/error reason "${event.reason}".`
          : `Wyoming session "${event.sessionId}" ended on ${event.connectionId}.`,
        [
          `reason=${event.reason}`,
          `durationMs=${event.durationMs}`,
          `activeSessions=${event.activeSessions}`,
        ],
      );
    });

    this.eventBus.on('wyoming.policy.violation', (event) => {
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Wyoming policy violation ${event.code} on ${event.connectionId}.`,
        [
          `scope=${event.scope}`,
          event.sessionId ? `sessionId=${event.sessionId}` : null,
          event.eventType ? `eventType=${event.eventType}` : null,
          event.limit !== undefined ? `limit=${event.limit}` : null,
          event.observed !== undefined ? `observed=${event.observed}` : null,
          `action=${event.action}`,
        ],
      );
    });
  }

  private appendAuditTimelineEntry(
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void {
    const detailText = details.filter((value): value is string => Boolean(value && value.trim())).join(' • ');
    this.auditTimeline.append({
      actionType,
      decision,
      narrative,
      details: detailText || undefined,
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

  memoryList(params?: URLSearchParams): string {
    const { limit, offset } = this.resolveMemoryListPagination(params);
    const memories = this.memoryStore.listActiveMemories({ limit, offset });
    const total = this.memoryStore.countActiveMemories();
    return tpl.layout(
      'Memory Blossoms',
      tpl.memoryListPage(
        memories,
        this.buildContactSummaryMap(),
        {
          limit,
          offset,
          total,
          hasPrevious: offset > 0,
          hasNext: offset + memories.length < total,
        },
      ),
      'memory',
    );
  }

  memoryDetail(id: string): string | null {
    const m = this.memoryStore.getById(id);
    if (!m) return null;
    const linkedContact = m.contactId ? this.buildContactSummaryMap().get(m.contactId) : undefined;
    return tpl.layout(`Memory: ${m.text.slice(0, 40)}...`, tpl.memoryDetailPage(m, linkedContact), 'memory');
  }

  memoryListFragment(params?: URLSearchParams): string {
    const { limit, offset } = this.resolveMemoryListPagination(params);
    const memories = this.memoryStore.listActiveMemories({ limit, offset });
    const contactsById = this.buildContactSummaryMap();
    return memories.length > 0
      ? memories.map(m => tpl.memoryRow(m, m.contactId ? contactsById.get(m.contactId) : undefined)).join('')
      : '<tr><td colspan="8" class="empty">No memories found</td></tr>';
  }

  async memorySearch(query: string): Promise<string> {
    if (!this.embeddingService) {
      return '<tr><td colspan="8" class="empty">Embedding service not available</td></tr>';
    }
    const embedding = await this.embeddingService.embed(query);
    const results = this.memoryStore.searchByEmbedding(embedding, 0.1, 50);
    const contactsById = this.buildContactSummaryMap();
    return results.length > 0
      ? results.map(m => tpl.memoryRow(m, m.contactId ? contactsById.get(m.contactId) : undefined)).join('')
      : '<tr><td colspan="8" class="empty">No matching memories</td></tr>';
  }

  memorySupersede(id: string): string {
    const m = this.memoryStore.getById(id);
    if (!m) {
      this.appendAuditTimelineEntry(
        'memory_mutation',
        'denied',
        `Memory supersede failed: memory "${id}" was not found.`,
      );
      return '';
    }
    this.memoryStore.updateMemory(id, { supersededBy: `admin-${randomUUID()}` });
    this.appendAuditTimelineEntry(
      'memory_mutation',
      'allowed',
      `PSFN superseded memory "${m.id}".`,
      [`source=${m.sourceRef}`],
    );
    return '';  // Remove the row
  }

  // ── Sessions ──

  private normalizeSessionChannelType(channelId: string): string {
    const parsed = this.splitSessionChannelId(channelId);
    if (parsed.channel !== 'session') return parsed.channel;
    if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) return 'discord';
    return parsed.channel;
  }

  private sessionMatchesConversationChannel(
    sessionChannelId: string,
    conversationChannel: ContactConversationChannelView,
  ): boolean {
    const normalizedSession = sessionChannelId.trim().toLowerCase();
    const normalizedChannel = conversationChannel.channel.trim().toLowerCase();
    const normalizedChannelId = conversationChannel.channelId.trim().toLowerCase();
    if (!normalizedChannelId) return false;
    return normalizedSession === normalizedChannelId
      || normalizedSession === `${normalizedChannel}:${normalizedChannelId}`;
  }

  private getLinkedContactForSession(channelId: string, contacts: Contact[]): Contact | undefined {
    if (!this.contactStore || contacts.length === 0) return undefined;

    const channelType = this.normalizeSessionChannelType(channelId);
    const lastEntry = this.sessionStore.getLastEntry(channelId);
    if (channelType !== 'session' && lastEntry?.authorId) {
      const contactByAuthor = this.contactStore.getByChannelIdentity(channelType, lastEntry.authorId);
      if (contactByAuthor) return contactByAuthor;
    }

    for (const contact of contacts) {
      const persistedChannels = this.getPersistedConversationChannels(contact);
      if (persistedChannels.some(entry => this.sessionMatchesConversationChannel(channelId, entry))) {
        return contact;
      }

      const identities = this.getContactIdentityLinks(contact);
      if (identities.some(identity => this.sessionMatchesIdentity(channelId, identity))) {
        return contact;
      }
    }

    const parsed = this.splitSessionChannelId(channelId);
    if (channelType !== 'session') {
      const userIdHint = parsed.channelId.split(':').pop();
      if (userIdHint) {
        const contactByHint = this.contactStore.getByChannelIdentity(channelType, userIdHint);
        if (contactByHint) return contactByHint;
      }
    }

    return undefined;
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

  sessionList(): string {
    const channels = this.sessionStore.listChannels();
    const contacts = this.contactStore?.listAll() ?? [];
    const renderedChannels = channels.map(channel => {
      const linkedContact = this.getLinkedContactForSession(channel.channelId, contacts);
      if (!linkedContact) return channel;
      return {
        ...channel,
        linkedContactId: linkedContact.id,
        linkedContactName: linkedContact.displayName,
      };
    });
    return tpl.layout('Conversation Roots', tpl.sessionListPage(renderedChannels), 'sessions');
  }

  sessionMessages(channelId: string): string {
    const messages = this.sessionManager.getRecentMessages(channelId, 100);
    const compactionAuditViews = this.buildCompactionAuditViews(channelId);
    return tpl.layout(
      `Session: ${channelId}`,
      tpl.sessionMessagesPage(channelId, messages, compactionAuditViews),
      'sessions',
    );
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
    const snapshot = this.cardVersionStore?.getCurrent();
    const history = this.cardVersionStore?.getHistory() ?? [];
    const card = snapshot?.card ?? this.characterCard;

    return tpl.layout(
      'Identity',
      tpl.identityPage(card, this.config, {
        version: snapshot?.version ?? 1,
        checksum: snapshot?.checksum,
        history,
        intakeReview: this.buildIdentityIntakeReviewState(),
      }),
      'identity',
    );
  }

  private buildIdentityIntakeReviewState(): IdentityIntakeReviewState | null {
    if (!this.stagedIntake) return null;
    const stage = this.stagedIntake;
    return {
      stageId: stage.id,
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      status: stage.status,
      sources: stage.sources,
      cardMutation: stage.cardMutation
        ? {
          sourcePath: stage.cardMutation.sourcePath,
          containerFormat: stage.cardMutation.containerFormat,
          spec: stage.cardMutation.spec,
          warnings: stage.cardMutation.warnings,
          status: stage.cardMutation.status,
          rows: stage.cardMutation.rows,
        }
        : undefined,
      chatProposal: stage.chatMutation
        ? {
          channelId: stage.chatMutation.channelId,
          totalMessages: stage.chatMutation.messages.length,
          chunkTargetTokens: stage.chatMutation.chunkTargetTokens,
          chunks: stage.chatMutation.chunks,
        }
        : undefined,
      memoryItems: stage.memoryMutations.map(item => ({
        id: item.id,
        source: item.source,
        textPreview: truncateDebugText(item.text, 220),
        type: item.type,
        importance: item.importance,
        salience: item.salience,
        criticality: item.criticality,
        mergeDecision: item.mergeDecision,
        mergeTargetId: item.mergeTargetId,
        existingSalience: item.existingSalience,
        proposedSalience: item.proposedSalience,
        provenanceRefs: item.provenanceRefs,
        relationshipTypeHint: item.relationshipTypeHint,
        relationshipUpdatePlanned: item.relationshipUpdatePlanned,
        relationshipUpdateApplied: item.relationshipUpdateApplied,
        status: item.status,
        error: item.error,
      })),
    };
  }

  private renderIdentityIntakeReview(flash?: IntakeFlash): string {
    return tpl.identityIntakeReviewFragment(this.buildIdentityIntakeReviewState(), flash);
  }

  private parseJsonFileFromPath(rawPath: string, label: string): unknown {
    const path = rawPath.trim();
    if (!path) {
      throw new Error(`${label} path is required`);
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read ${label} file "${path}": ${message}`);
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} file "${path}" is not valid JSON: ${message}`);
    }
  }

  private parseChatMessagesFromPayload(payload: unknown): StagedIntakeChatMessage[] {
    let rows: unknown[] = [];
    if (Array.isArray(payload)) {
      rows = payload;
    } else {
      const record = toRecord(payload);
      if (record) {
        const candidates = record.messages ?? record.chat ?? record.turns ?? record.entries;
        if (Array.isArray(candidates)) rows = candidates;
      }
    }

    const now = Date.now();
    const messages: StagedIntakeChatMessage[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (typeof row === 'string') {
        const content = row.trim();
        if (!content) continue;
        messages.push({
          role: 'user',
          content,
          timestamp: now + index,
        });
        continue;
      }

      const entry = toRecord(row);
      if (!entry) continue;
      const content = toNonEmptyString(entry.content)
        ?? toNonEmptyString(entry.text)
        ?? toNonEmptyString(entry.message)
        ?? toNonEmptyString(entry.body);
      if (!content) continue;

      messages.push({
        role: normalizeSessionRole(entry.role ?? entry.speaker ?? entry.authorRole ?? entry.type),
        content,
        timestamp: parseTimestamp(
          entry.timestamp ?? entry.createdAt ?? entry.created_at ?? entry.date,
          now + index,
        ),
        authorId: toNonEmptyString(entry.authorId) ?? toNonEmptyString(entry.userId) ?? undefined,
        authorName: toNonEmptyString(entry.authorName)
          ?? toNonEmptyString(entry.author)
          ?? toNonEmptyString(entry.name)
          ?? undefined,
      });
    }

    return messages;
  }

  private chunkChatMessages(
    messages: readonly StagedIntakeChatMessage[],
    chunkTargetTokens: number,
  ): IdentityIntakeChatChunk[] {
    if (messages.length === 0) return [];
    const chunks: IdentityIntakeChatChunk[] = [];
    let chunkStart = 0;
    let chunkTokenCount = 0;
    let chunkIndex = 1;

    const pushChunk = (endExclusive: number, tokenCount: number): void => {
      if (endExclusive <= chunkStart) return;
      const messageCount = endExclusive - chunkStart;
      chunks.push({
        id: `chat-chunk-${chunkIndex}`,
        index: chunkIndex,
        startMessage: chunkStart + 1,
        endMessage: endExclusive,
        messageCount,
        estimatedTokens: tokenCount,
        status: 'pending',
      });
      chunkIndex += 1;
      chunkStart = endExclusive;
      chunkTokenCount = 0;
    };

    for (let idx = 0; idx < messages.length; idx++) {
      const messageTokens = estimateTokens(messages[idx].content);
      if (chunkTokenCount > 0 && chunkTokenCount + messageTokens > chunkTargetTokens) {
        pushChunk(idx, chunkTokenCount);
      }
      chunkTokenCount += messageTokens;
    }

    pushChunk(messages.length, chunkTokenCount);
    return chunks;
  }

  private parseMemoryItemsFromPayload(payload: unknown, sourcePath?: string): ParsedRawMemoryItem[] {
    let rows: unknown[] = [];
    if (Array.isArray(payload)) {
      rows = payload;
    } else {
      const record = toRecord(payload);
      if (record) {
        const candidates = record.memories ?? record.memory ?? record.items ?? record.entries;
        if (Array.isArray(candidates)) rows = candidates;
      }
    }

    const items: ParsedRawMemoryItem[] = [];
    for (const row of rows) {
      const entry = toRecord(row);
      if (!entry) continue;
      const text = toNonEmptyString(entry.text)
        ?? toNonEmptyString(entry.content)
        ?? toNonEmptyString(entry.memory)
        ?? toNonEmptyString(entry.summary);
      if (!text) continue;

      const tags = uniqueLowercase(
        toStringArray(entry.tags)
          .concat(toStringArray(entry.keywords))
          .concat(toStringArray(entry.labels)),
      );
      const type = inferImportedMemoryType({
        text,
        explicitType: entry.type ?? entry.memoryType,
        tags,
      });
      const importance = clampUnit(
        toNumber(entry.importance)
          ?? toNumber(entry.priority)
          ?? toNumber(entry.weight)
          ?? 0.5,
      );
      const now = Date.now();
      const extractedAt = parseTimestamp(
        entry.extractedAt
          ?? entry.extracted_at
          ?? entry.createdAt
          ?? entry.created_at
          ?? entry.timestamp
          ?? entry.date,
        now,
      );
      const lastAccessed = parseTimestamp(
        entry.lastAccessed
          ?? entry.last_accessed
          ?? entry.updatedAt
          ?? entry.updated_at
          ?? entry.last_seen
          ?? extractedAt,
        extractedAt,
      );
      const salience = initializeImportedMemorySalience({
        importance,
        salience: toNumber(entry.salience) ?? undefined,
        type,
        tags,
        text,
        extractedAt,
        lastAccessed,
      });
      const criticality = estimateImportedMemoryCriticality({
        type,
        importance,
        tags,
        text,
      });
      const fallbackRef = sourcePath
        ? `legacy:${sourcePath}#memory-${items.length + 1}`
        : `legacy:memory#${items.length + 1}`;
      const provenanceRefs = parseProvenanceRefs(entry, fallbackRef);
      const relationshipTypeHint = inferRelationshipTypeHint({
        explicitValue: entry.relationshipType ?? entry.relationship_type,
        text,
        tags,
        type,
      });

      items.push({
        text,
        type,
        importance,
        salience,
        criticality,
        tags,
        provenanceRefs,
        sensitivity: normalizeSensitivity(entry.sensitivity),
        contactId: toNonEmptyString(entry.contactId) ?? toNonEmptyString(entry.contact_id) ?? undefined,
        extractedAt,
        lastAccessed,
        relationshipTypeHint,
      });
    }
    return items;
  }

  private parseLorebookItemsFromPayload(payload: unknown, sourcePath?: string): ParsedRawMemoryItem[] {
    let rows: unknown[] = [];
    if (Array.isArray(payload)) {
      rows = payload;
    } else {
      const root = toRecord(payload);
      if (root) {
        const topLevel = root.entries ?? root.items ?? root.lorebook;
        if (Array.isArray(topLevel)) rows = topLevel;
        if (rows.length === 0) {
          const cardData = toRecord(root.data);
          const characterBook = toRecord(cardData?.character_book ?? root.character_book);
          if (characterBook && Array.isArray(characterBook.entries)) {
            rows = characterBook.entries;
          }
        }
      }
    }

    const items: ParsedRawMemoryItem[] = [];
    for (const row of rows) {
      const entry = toRecord(row);
      if (!entry) continue;
      const text = toNonEmptyString(entry.content)
        ?? toNonEmptyString(entry.text)
        ?? toNonEmptyString(entry.description)
        ?? toNonEmptyString(entry.comment);
      if (!text) continue;

      const keywords = toStringArray(entry.keys)
        .concat(toStringArray(entry.keywords))
        .concat(toStringArray(entry.trigger_words))
        .slice(0, 6);
      const tags = uniqueLowercase(['lorebook', ...keywords]);
      const type = inferImportedMemoryType({
        text,
        explicitType: entry.type ?? 'semantic',
        tags,
      });
      const importance = clampUnit(
        toNumber(entry.importance)
          ?? toNumber(entry.priority)
          ?? toNumber(entry.weight)
          ?? 0.55,
      );
      const now = Date.now();
      const extractedAt = parseTimestamp(
        entry.updatedAt
          ?? entry.updated_at
          ?? entry.createdAt
          ?? entry.created_at
          ?? entry.timestamp,
        now,
      );
      const lastAccessed = extractedAt;
      const salience = initializeImportedMemorySalience({
        importance,
        salience: toNumber(entry.salience) ?? undefined,
        type,
        tags,
        text,
        extractedAt,
        lastAccessed,
      });
      const criticality = estimateImportedMemoryCriticality({
        type,
        importance,
        tags,
        text,
      });
      const fallbackRef = sourcePath
        ? `legacy:${sourcePath}#lorebook-${items.length + 1}`
        : `legacy:lorebook#${items.length + 1}`;
      const provenanceRefs = parseProvenanceRefs(entry, fallbackRef);
      const relationshipTypeHint = inferRelationshipTypeHint({
        explicitValue: entry.relationshipType ?? entry.relationship_type,
        text,
        tags,
        type,
      });

      items.push({
        text,
        type,
        importance,
        salience,
        criticality,
        tags,
        provenanceRefs,
        sensitivity: normalizeSensitivity(entry.sensitivity),
        contactId: toNonEmptyString(entry.contactId) ?? toNonEmptyString(entry.contact_id) ?? undefined,
        extractedAt,
        lastAccessed,
        relationshipTypeHint,
      });
    }

    return items;
  }

  private stageMemoryMutations(
    items: readonly ParsedRawMemoryItem[],
    source: 'lorebook' | 'memory',
  ): StagedIntakeMemoryMutation[] {
    const existingByText = new Map<string, ReturnType<MemoryStore['getAllActiveMemories']>[number]>();
    for (const memory of this.memoryStore.getAllActiveMemories()) {
      const key = buildMemoryDedupKey(memory.text, memory.type, memory.contactId);
      if (!key) continue;
      const previous = existingByText.get(key);
      if (previous && previous.salience >= memory.salience) continue;
      existingByText.set(key, memory);
    }

    return items.map((item, index) => {
      const key = buildMemoryDedupKey(item.text, item.type, item.contactId);
      const existing = key ? existingByText.get(key) : undefined;
      const mergeDecision: IdentityIntakeMemoryItem['mergeDecision'] = existing ? 'merge' : 'create';
      const proposedSalience = existing ? Math.max(existing.salience, item.salience) : item.salience;
      const relationshipUpdatePlanned = this.resolveRelationshipUpdatePlan(
        item.contactId,
        item.relationshipTypeHint,
      );
      return {
        id: `${source}-item-${index + 1}`,
        source,
        text: item.text,
        type: item.type,
        importance: item.importance,
        salience: item.salience,
        criticality: item.criticality,
        mergeDecision,
        mergeTargetId: existing?.id,
        existingSalience: existing?.salience,
        proposedSalience,
        status: 'pending',
        tags: item.tags,
        provenanceRefs: item.provenanceRefs,
        sensitivity: item.sensitivity,
        contactId: item.contactId,
        extractedAt: item.extractedAt,
        lastAccessed: item.lastAccessed,
        relationshipTypeHint: item.relationshipTypeHint,
        relationshipUpdatePlanned,
      };
    });
  }

  private resolveRelationshipUpdatePlan(
    contactId: string | undefined,
    candidate: RelationshipType | undefined,
  ): RelationshipType | undefined {
    if (!contactId || !candidate || !this.contactStore) return undefined;
    const contact = this.contactStore.getById(contactId);
    if (!contact) return undefined;
    if (!shouldPromoteRelationship(contact.relationshipType, candidate)) return undefined;
    return candidate;
  }

  private applyRelationshipUpdate(
    contactId: string | undefined,
    candidate: RelationshipType | undefined,
  ): RelationshipType | undefined {
    if (!contactId || !candidate || !this.contactStore) return undefined;
    const planned = this.resolveRelationshipUpdatePlan(contactId, candidate);
    if (!planned) return undefined;
    const updated = this.contactStore.updateRelationshipType(contactId, planned);
    return updated ? planned : undefined;
  }

  private recomputeStagedIntakeStatus(stage: StagedIdentityIntake): void {
    const statuses: IdentityIntakeItemStatus[] = [];
    if (stage.cardMutation) statuses.push(stage.cardMutation.status);
    if (stage.chatMutation) statuses.push(...stage.chatMutation.chunks.map(chunk => chunk.status));
    statuses.push(...stage.memoryMutations.map(item => item.status));

    const pending = statuses.filter(status => status === 'pending').length;
    const committed = statuses.filter(status => status === 'committed').length;
    const rejected = statuses.filter(status => status === 'rejected').length;
    const failed = statuses.filter(status => status === 'failed').length;

    if (pending === 0 && committed > 0 && rejected === 0 && failed === 0) {
      stage.status = 'committed';
    } else if (pending === 0 && committed === 0 && (rejected > 0 || failed > 0)) {
      stage.status = 'rejected';
    } else if (committed > 0 || rejected > 0 || failed > 0) {
      stage.status = 'partially_committed';
    } else {
      stage.status = 'pending';
    }
    stage.updatedAt = Date.now();
  }

  stageIdentityIntake(body: string): string {
    const params = new URLSearchParams(body);
    const cardPath = (params.get('cardPath') ?? '').trim();
    const chatPath = (params.get('chatPath') ?? '').trim();
    const lorebookPath = (params.get('lorebookPath') ?? '').trim();
    const memoryPath = (params.get('memoryPath') ?? '').trim();

    if (!cardPath && !chatPath && !lorebookPath && !memoryPath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Staged intake was denied: no source paths were provided.',
      );
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'Provide at least one source path to stage.',
      });
    }

    try {
      const now = Date.now();
      const stage: StagedIdentityIntake = {
        id: `intake-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        sources: [],
        cardMutation: null,
        chatMutation: null,
        memoryMutations: [],
      };

      if (cardPath) {
        const imported = importCharacterCardFromPath(cardPath);
        const rows = INTAKE_CARD_DIFF_FIELDS.map(({ key, label }) => {
          const previous = normalizeCardFieldValue(this.characterCard, key);
          const next = normalizeCardFieldValue(imported.card, key);
          return {
            field: label,
            previous,
            next,
            changed: previous !== next,
          };
        });
        stage.cardMutation = {
          sourcePath: imported.sourcePath,
          containerFormat: imported.containerFormat,
          spec: imported.spec,
          warnings: imported.warnings,
          status: 'pending',
          rows,
          importedCard: imported.card,
        };
        stage.sources.push({
          kind: 'card',
          path: imported.sourcePath,
          itemCount: 1,
          note: imported.warnings.length > 0 ? imported.warnings.join('; ') : undefined,
        });
      }

      if (chatPath) {
        const payload = this.parseJsonFileFromPath(chatPath, 'Chat');
        const messages = this.parseChatMessagesFromPayload(payload);
        if (messages.length === 0) {
          throw new Error(`Chat source "${chatPath}" produced no valid messages`);
        }
        const channelId = (params.get('chatChannelId') ?? '').trim() || `import:${stage.id}`;
        const chunkTargetTokens = parsePositiveInteger(
          params.get('chatChunkTargetTokens'),
          DEFAULT_CHAT_CHUNK_TARGET_TOKENS,
          MIN_CHAT_CHUNK_TARGET_TOKENS,
          MAX_CHAT_CHUNK_TARGET_TOKENS,
        );
        const chunks = this.chunkChatMessages(messages, chunkTargetTokens);
        stage.chatMutation = {
          channelId,
          chunkTargetTokens,
          messages,
          chunks,
        };
        stage.sources.push({
          kind: 'chat',
          path: chatPath,
          itemCount: messages.length,
          note: `${chunks.length} chunks @ ~${chunkTargetTokens} tokens`,
        });
      }

      if (lorebookPath) {
        const payload = this.parseJsonFileFromPath(lorebookPath, 'Lorebook');
        const lorebookItems = this.parseLorebookItemsFromPayload(payload, lorebookPath);
        if (lorebookItems.length === 0) {
          throw new Error(`Lorebook source "${lorebookPath}" produced no valid entries`);
        }
        stage.memoryMutations.push(...this.stageMemoryMutations(lorebookItems, 'lorebook'));
        stage.sources.push({
          kind: 'lorebook',
          path: lorebookPath,
          itemCount: lorebookItems.length,
        });
      }

      if (memoryPath) {
        const payload = this.parseJsonFileFromPath(memoryPath, 'Memory');
        const memoryItems = this.parseMemoryItemsFromPayload(payload, memoryPath);
        if (memoryItems.length === 0) {
          throw new Error(`Memory source "${memoryPath}" produced no valid entries`);
        }
        stage.memoryMutations.push(...this.stageMemoryMutations(memoryItems, 'memory'));
        stage.sources.push({
          kind: 'memory',
          path: memoryPath,
          itemCount: memoryItems.length,
        });
      }

      if (!stage.cardMutation && !stage.chatMutation && stage.memoryMutations.length === 0) {
        throw new Error('No mutations were parsed from the provided intake sources');
      }

      this.stagedIntake = stage;
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN staged intake bundle ${stage.id} for operator review.`,
        [
          `sources=${stage.sources.map(source => source.kind).join(',')}`,
          stage.chatMutation ? `chatChunks=${stage.chatMutation.chunks.length}` : null,
          stage.memoryMutations.length > 0 ? `memoryItems=${stage.memoryMutations.length}` : null,
        ],
      );
      return this.renderIdentityIntakeReview({
        kind: 'success',
        message: `Staged intake bundle ${stage.id}. Review proposed changes, then approve/reject/commit selected.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Staged intake failed: ${message}`,
      );
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Staging failed: ${message}`,
      });
    }
  }

  async commitIdentityIntake(body: string): Promise<string> {
    if (!this.stagedIntake) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'No staged intake bundle is available.',
      });
    }

    const stage = this.stagedIntake;
    const params = new URLSearchParams(body);
    const stageId = (params.get('stageId') ?? '').trim();
    if (stageId && stageId !== stage.id) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Staged bundle changed. Active stage is ${stage.id}.`,
      });
    }

    const decision = (params.get('decision') ?? '').trim();
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'partial') {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: `Unknown review decision "${decision}".`,
      });
    }

    const reason = (params.get('reason') ?? '').trim();
    const pendingCard = stage.cardMutation?.status === 'pending';
    const pendingChatChunks = stage.chatMutation?.chunks.filter(chunk => chunk.status === 'pending') ?? [];
    const pendingMemoryItems = stage.memoryMutations.filter(item => item.status === 'pending');

    if (!pendingCard && pendingChatChunks.length === 0 && pendingMemoryItems.length === 0) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'No pending staged changes remain.',
      });
    }

    if (decision === 'reject') {
      if (stage.cardMutation?.status === 'pending') stage.cardMutation.status = 'rejected';
      for (const chunk of pendingChatChunks) chunk.status = 'rejected';
      for (const item of pendingMemoryItems) item.status = 'rejected';
      stage.status = 'rejected';
      stage.updatedAt = Date.now();

      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Operator rejected staged intake bundle ${stage.id}.`,
        [
          pendingCard ? 'card=rejected' : null,
          pendingChatChunks.length > 0 ? `chatChunksRejected=${pendingChatChunks.length}` : null,
          pendingMemoryItems.length > 0 ? `memoryItemsRejected=${pendingMemoryItems.length}` : null,
          reason ? `note=${reason}` : null,
        ],
      );
      return this.renderIdentityIntakeReview({
        kind: 'success',
        message: `Rejected pending changes for bundle ${stage.id}.`,
      });
    }

    const applyCard = decision === 'approve'
      ? pendingCard
      : (pendingCard && (params.get('applyCard') === 'true' || params.get('applyCard') === 'on'));
    const selectedChatChunkIds = decision === 'approve'
      ? new Set(pendingChatChunks.map(chunk => chunk.id))
      : new Set(
        params.getAll('chatChunkId')
          .map(value => value.trim())
          .filter(Boolean),
      );
    const selectedMemoryItemIds = decision === 'approve'
      ? new Set(pendingMemoryItems.map(item => item.id))
      : new Set(
        params.getAll('memoryItemId')
          .map(value => value.trim())
          .filter(Boolean),
      );

    if (!applyCard && selectedChatChunkIds.size === 0 && selectedMemoryItemIds.size === 0) {
      return this.renderIdentityIntakeReview({
        kind: 'error',
        message: 'Select at least one pending mutation to commit.',
      });
    }

    let committedCard = false;
    let committedChatChunks = 0;
    let committedChatMessages = 0;
    let committedMemoryItems = 0;
    let committedRelationshipUpdates = 0;
    let failedCard = false;
    let failedChatChunks = 0;
    let failedMemoryItems = 0;

    if (applyCard && stage.cardMutation && stage.cardMutation.status === 'pending') {
      try {
        const destinationPath = this.config.characterCardPath?.trim();
        if (this.cardVersionStore) {
          const updated = this.cardVersionStore.update(
            stage.cardMutation.importedCard,
            'admin:intake',
            reason || `Committed staged intake bundle ${stage.id}`,
          );
          this.characterCard = updated.card;
        } else {
          if (destinationPath) {
            writeNormalizedCharacterCard(destinationPath, stage.cardMutation.importedCard);
          }
          this.characterCard = stage.cardMutation.importedCard;
        }
        stage.cardMutation.status = 'committed';
        committedCard = true;
      } catch (error) {
        stage.cardMutation.status = 'failed';
        failedCard = true;
      }
    }

    if (stage.chatMutation) {
      for (const chunk of stage.chatMutation.chunks) {
        if (chunk.status !== 'pending' || !selectedChatChunkIds.has(chunk.id)) continue;
        try {
          const rows = stage.chatMutation.messages.slice(chunk.startMessage - 1, chunk.endMessage);
          for (const message of rows) {
            this.sessionStore.append({
              channelId: stage.chatMutation.channelId,
              role: message.role,
              content: message.content,
              authorId: message.authorId,
              authorName: message.authorName,
              timestamp: message.timestamp,
              metadata: JSON.stringify({
                type: 'admin_staged_intake',
                stageId: stage.id,
                chunkId: chunk.id,
              }),
            });
          }
          chunk.status = 'committed';
          committedChatChunks += 1;
          committedChatMessages += rows.length;
        } catch (error) {
          chunk.status = 'failed';
          chunk.error = error instanceof Error ? error.message : String(error);
          failedChatChunks += 1;
        }
      }
    }

    for (const item of stage.memoryMutations) {
      if (item.status !== 'pending' || !selectedMemoryItemIds.has(item.id)) continue;
      try {
        if (item.mergeDecision === 'merge' && item.mergeTargetId) {
          const existing = this.memoryStore.getById(item.mergeTargetId);
          if (!existing) {
            throw new Error(`merge target "${item.mergeTargetId}" was not found`);
          }
          const mergedSalience = Math.max(existing.salience, item.salience);
          const mergedTags = uniqueLowercase([...existing.tags, ...item.tags]);
          const mergedProvenanceRefs = normalizeProvenanceRefs(
            [...(existing.provenanceRefs ?? []), existing.sourceRef, ...(item.provenanceRefs ?? [])],
          );
          this.memoryStore.updateMemory(existing.id, {
            salience: mergedSalience,
            tags: mergedTags,
            provenanceRefs: mergedProvenanceRefs,
            contactId: existing.contactId ?? item.contactId,
            lastAccessed: Date.now(),
            accessCount: existing.accessCount + 1,
          });
          item.proposedSalience = mergedSalience;
          item.provenanceRefs = mergedProvenanceRefs;
        } else {
          if (!this.embeddingService) {
            throw new Error('Embedding service is not configured for new memory writes');
          }
          const embedding = await this.embeddingService.embed(item.text);
          const now = Date.now();
          const sourceRef = item.provenanceRefs?.[0]
            ?? `admin:intake:${stage.id}:${item.source}`;
          this.memoryStore.insertMemory({
            id: `intake-${randomUUID()}`,
            text: item.text,
            type: item.type,
            importance: item.importance,
            confidence: 0.82,
            emotionalValence: 0,
            salience: item.salience,
            sourceRef,
            extractedAt: item.extractedAt ?? now,
            lastAccessed: item.lastAccessed ?? item.extractedAt ?? now,
            accessCount: 1,
            tags: item.tags,
            provenanceRefs: normalizeProvenanceRefs(item.provenanceRefs ?? [], sourceRef),
            sensitivity: item.sensitivity,
            contactId: item.contactId,
          }, embedding);
        }
        const relationshipApplied = this.applyRelationshipUpdate(
          item.contactId,
          item.relationshipTypeHint,
        );
        item.relationshipUpdateApplied = relationshipApplied;
        if (relationshipApplied) committedRelationshipUpdates += 1;
        item.status = 'committed';
        item.error = undefined;
        committedMemoryItems += 1;
      } catch (error) {
        item.status = 'failed';
        item.error = error instanceof Error ? error.message : String(error);
        failedMemoryItems += 1;
      }
    }

    this.recomputeStagedIntakeStatus(stage);

    this.appendAuditTimelineEntry(
      'identity_edit',
      failedCard || failedChatChunks > 0 || failedMemoryItems > 0 ? 'denied' : 'allowed',
      `Operator applied "${decision}" decision to staged intake bundle ${stage.id}.`,
      [
        committedCard ? 'card=committed' : null,
        committedChatChunks > 0 ? `chatChunksCommitted=${committedChatChunks}` : null,
        committedChatMessages > 0 ? `chatMessagesCommitted=${committedChatMessages}` : null,
        committedMemoryItems > 0 ? `memoryItemsCommitted=${committedMemoryItems}` : null,
        committedRelationshipUpdates > 0 ? `relationshipUpdates=${committedRelationshipUpdates}` : null,
        failedCard ? 'card=failed' : null,
        failedChatChunks > 0 ? `chatChunksFailed=${failedChatChunks}` : null,
        failedMemoryItems > 0 ? `memoryItemsFailed=${failedMemoryItems}` : null,
        reason ? `note=${reason}` : null,
      ],
    );

    if (committedMemoryItems > 0 || failedMemoryItems > 0) {
      this.appendAuditTimelineEntry(
        'memory_mutation',
        failedMemoryItems > 0 ? 'denied' : 'allowed',
        failedMemoryItems > 0
          ? `Staged memory commit finished with failures for bundle ${stage.id}.`
          : `Staged memory commit completed for bundle ${stage.id}.`,
        [
          `committed=${committedMemoryItems}`,
          `failed=${failedMemoryItems}`,
        ],
      );
    }

    const summary: string[] = [];
    if (committedCard) summary.push('card committed');
    if (committedChatChunks > 0) summary.push(`${committedChatChunks} chat chunks committed`);
    if (committedMemoryItems > 0) summary.push(`${committedMemoryItems} memory items committed`);
    if (committedRelationshipUpdates > 0) summary.push(`${committedRelationshipUpdates} relationship updates applied`);
    if (failedCard) summary.push('card failed');
    if (failedChatChunks > 0) summary.push(`${failedChatChunks} chat chunks failed`);
    if (failedMemoryItems > 0) summary.push(`${failedMemoryItems} memory items failed`);
    if (summary.length === 0) summary.push('no pending items matched selection');

    return this.renderIdentityIntakeReview({
      kind: failedCard || failedChatChunks > 0 || failedMemoryItems > 0 ? 'error' : 'success',
      message: summary.join('; '),
    });
  }

  private resolveCharacterImportAssetRootDir(): string | null {
    const dataDir = this.config.dataDir?.trim();
    if (!dataDir) return null;
    return join(dataDir, 'identity-assets');
  }

  private buildCharacterBookSeedWrites(
    seeds: readonly CharacterMemorySeed[],
    sourcePath: string,
  ): MemoryWriteOptions[] {
    const sourceToken = encodeURIComponent(sourcePath);
    return seeds.map((seed, index) => ({
      text: seed.text,
      type: seed.type,
      importance: seed.importance,
      tags: uniqueLowercase(['character_import', ...seed.tags]),
      sourceRef: `admin:import:character_book:${sourceToken}:${index + 1}`,
      sensitivity: seed.sensitivity,
    }));
  }

  private async importCharacterBookSeeds(
    seeds: readonly CharacterMemorySeed[],
    sourcePath: string,
  ): Promise<{
    attempted: number;
    written: number;
    deduplicated: number;
    superseded: number;
    errors: number;
    skippedReason?: string;
  }> {
    if (seeds.length === 0) {
      return {
        attempted: 0,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
      };
    }

    if (!this.importMemoryWriter) {
      return {
        attempted: seeds.length,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
        skippedReason: 'memory writer is not configured',
      };
    }

    try {
      const result = await this.importMemoryWriter.importBatch(
        this.buildCharacterBookSeedWrites(seeds, sourcePath),
      );
      return {
        attempted: seeds.length,
        written: result.written,
        deduplicated: result.deduplicated,
        superseded: result.superseded,
        errors: result.errors,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        attempted: seeds.length,
        written: 0,
        deduplicated: 0,
        superseded: 0,
        errors: 0,
        skippedReason: message,
      };
    }
  }

  async importIdentityCard(body: string): Promise<string> {
    const params = new URLSearchParams(body);
    const sourcePath = (params.get('path') ?? '').trim();
    if (!sourcePath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity import was denied: source path was not provided.',
      );
      return tpl.identityImportResult(false, 'path is required');
    }

    const destinationPath = this.config.characterCardPath?.trim();
    if (!destinationPath) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity import was denied: CHARACTER_CARD_PATH is not configured.',
      );
      return tpl.identityImportResult(false, 'CHARACTER_CARD_PATH is not configured');
    }

    try {
      const imported = importCharacterCardFromPath(sourcePath);
      if (this.cardVersionStore) {
        const updated = this.cardVersionStore.update(
          imported.card,
          'admin:import',
          `Imported from ${imported.sourcePath}`,
        );
        this.characterCard = updated.card;
      } else {
        writeNormalizedCharacterCard(destinationPath, imported.card);
        this.characterCard = imported.card;
      }

      const warnings = [...imported.warnings];

      let persistedAssetCount = 0;
      let assetRootDir: string | null = null;
      if (imported.assets.length > 0) {
        assetRootDir = this.resolveCharacterImportAssetRootDir();
        if (!assetRootDir) {
          warnings.push('Extracted media assets were not persisted because dataDir is not configured.');
        } else {
          try {
            persistExtractedCharacterAssets(imported.assets, assetRootDir);
            persistedAssetCount = imported.assets.length;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Extracted media assets were not persisted: ${message}`);
          }
        }
      }

      const memorySeedResult = await this.importCharacterBookSeeds(
        imported.memorySeeds,
        imported.sourcePath,
      );
      if (memorySeedResult.skippedReason) {
        warnings.push(`Character-book memory seeding skipped: ${memorySeedResult.skippedReason}`);
      } else if (memorySeedResult.errors > 0) {
        warnings.push(`Character-book memory seeding completed with ${memorySeedResult.errors} errors.`);
      }

      const summaryDetails: string[] = [];
      if (imported.memorySeeds.length > 0) {
        if (memorySeedResult.skippedReason) {
          summaryDetails.push(`parsed ${imported.memorySeeds.length} character-book seeds (write skipped)`);
        } else {
          summaryDetails.push(
            `character-book seeds: ${memorySeedResult.written} written, ${memorySeedResult.deduplicated} deduplicated`,
          );
        }
      }
      if (imported.assets.length > 0) {
        summaryDetails.push(
          persistedAssetCount > 0
            ? `persisted ${persistedAssetCount} media assets`
            : `extracted ${imported.assets.length} media assets (persistence skipped)`,
        );
      }

      const warningSuffix = warnings.length > 0
        ? ` Warnings: ${warnings.join('; ')}`
        : '';
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN imported an identity card from ${imported.sourcePath}.`,
        [
          `name=${imported.card.data.name}`,
          `format=${imported.containerFormat}`,
          `spec=${imported.spec}`,
          imported.memorySeeds.length > 0 ? `memorySeeds=${imported.memorySeeds.length}` : null,
          memorySeedResult.attempted > 0 && !memorySeedResult.skippedReason
            ? `memoryWrites=${memorySeedResult.written}/${memorySeedResult.deduplicated}/${memorySeedResult.errors}`
            : null,
          imported.assets.length > 0 ? `assets=${imported.assets.length}` : null,
          assetRootDir && persistedAssetCount > 0 ? `assetRoot=${assetRootDir}` : null,
        ],
      );
      return tpl.identityImportResult(
        true,
        `Imported "${imported.card.data.name}" from ${imported.sourcePath} (${imported.containerFormat}/${imported.spec}).`
          + `${summaryDetails.length > 0 ? ` ${summaryDetails.join('; ')}.` : ''}`
          + warningSuffix,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity import failed: ${message}`,
        [`source=${sourcePath}`],
      );
      return tpl.identityImportResult(false, `Import failed: ${message}`);
    }
  }

  rollbackIdentityCard(body: string): string {
    if (!this.cardVersionStore) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        'Identity rollback was denied: versioning is not configured.',
      );
      return tpl.identityCardVersionResult(false, 'Character card versioning is not configured.');
    }
    const params = new URLSearchParams(body);
    const rawVersion = params.get('version') ?? '';
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version <= 0) {
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity rollback was denied: invalid version "${rawVersion}".`,
      );
      return tpl.identityCardVersionResult(false, 'version must be a positive integer.');
    }

    try {
      const snapshot = this.cardVersionStore.rollback(version);
      this.characterCard = snapshot.card;
      this.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN rolled identity back to version ${version}.`,
        [`currentVersion=${snapshot.version}`],
      );
      return tpl.identityCardVersionResult(
        true,
        `Rolled back to version ${version}. Current version is v${snapshot.version}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendAuditTimelineEntry(
        'identity_edit',
        'denied',
        `Identity rollback failed: ${message}`,
        [`version=${version}`],
      );
      return tpl.identityCardVersionResult(false, message);
    }
  }

  previewIdentityCardDiff(body: string): string {
    if (!this.cardVersionStore) {
      return '<div class="form-error">Character card versioning is not configured.</div>';
    }
    const params = new URLSearchParams(body);
    const rawVersion = params.get('version') ?? '';
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version <= 0) {
      return '<div class="form-error">version must be a positive integer.</div>';
    }

    const entry = this.cardVersionStore.getHistoryEntry(version);
    if (!entry) {
      return `<div class="form-error">No history entry found for version ${version}.</div>`;
    }

    return tpl.identityCardDiffFragment(entry.previousCard, entry.newCard, {
      fromVersion: entry.version,
      toVersion: entry.version + 1,
      updatedBy: entry.updatedBy,
      timestamp: entry.timestamp,
      reason: entry.reason,
    });
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
    return error instanceof Error ? error.message : String(error);
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
        const message = error instanceof Error ? error.message : String(error);
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
        const saved = saveCapabilityTierConfig(this.config.dataDir, {
          ...current,
          tier: capabilityTierInput,
        });
        this.config.capabilityTier = saved.tier;
        this.config.runtimeHooks?.refreshCapabilities?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return tpl.settingsFormResult(false, `Settings saved but capability tier update failed: ${message}`);
      }
    }

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

  // ── Chat ──

  chatPage(): string {
    return tpl.layout('Garden Chat', tpl.chatPage(), 'chat');
  }

  async confirmationsPage(): Promise<string> {
    const body = await this.renderConfirmationQueueFragment();
    return tpl.layout('Confirmations', tpl.confirmationsPage(body), 'confirmations');
  }

  async confirmationsListFragment(): Promise<string> {
    return this.renderConfirmationQueueFragment();
  }

  async resolveConfirmation(body: string): Promise<string> {
    if (!this.confirmationQueueApi) {
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        'Confirmation decision was denied: confirmation queue is unavailable.',
      );
      return this.renderConfirmationQueueFragment(
        'Confirmation queue is unavailable (gateway integration not configured).',
        true,
      );
    }

    const params = new URLSearchParams(body);
    const id = (params.get('id') ?? '').trim();
    const decisionRaw = (params.get('decision') ?? '').trim();
    if (!id) {
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        'Confirmation decision was denied: missing confirmation id.',
      );
      return this.renderConfirmationQueueFragment('Confirmation ID is required.', true);
    }

    if (decisionRaw !== 'approve' && decisionRaw !== 'deny' && decisionRaw !== 'modify') {
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Confirmation ${id} was denied: invalid decision "${decisionRaw}".`,
      );
      return this.renderConfirmationQueueFragment('Invalid confirmation decision.', true);
    }

    const resolveParams: ConfirmationResolveParams = {
      id,
      decision: decisionRaw,
    };

    if (decisionRaw === 'modify') {
      const modifiedParamsRaw = (params.get('modifiedParamsJson') ?? '').trim();
      if (!modifiedParamsRaw) {
        this.appendAuditTimelineEntry(
          'external_action',
          'denied',
          `Confirmation ${id} modify request was denied: modified params were not provided.`,
        );
        return this.renderConfirmationQueueFragment('Modified params JSON is required for modify.', true);
      }
      try {
        const parsed = JSON.parse(modifiedParamsRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.appendAuditTimelineEntry(
            'external_action',
            'denied',
            `Confirmation ${id} modify request was denied: modified params were not a JSON object.`,
          );
          return this.renderConfirmationQueueFragment('Modified params must be a JSON object.', true);
        }
        resolveParams.modifiedParams = parsed as Record<string, unknown>;
      } catch {
        this.appendAuditTimelineEntry(
          'external_action',
          'denied',
          `Confirmation ${id} modify request was denied: modified params JSON was invalid.`,
        );
        return this.renderConfirmationQueueFragment('Modified params JSON is invalid.', true);
      }
    }

    let result: ConfirmationResolveResult;
    try {
      result = await this.confirmationQueueApi.resolveConfirmationQueue(resolveParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Confirmation ${id} failed to resolve: ${message}`,
      );
      return this.renderConfirmationQueueFragment(`Confirmation update failed: ${message}`, true);
    }

    const isError = result.status === 'failed';
    const decision: AdminAuditDecision = (
      result.status === 'denied'
      || result.status === 'failed'
      || result.status === 'expired'
      || result.status === 'not_found'
    ) ? 'denied' : 'allowed';
    const decisionLabel = decisionRaw === 'modify'
      ? 'modified'
      : (decisionRaw === 'approve' ? 'approved' : 'denied');
    this.appendAuditTimelineEntry(
      'external_action',
      decision,
      `Operator ${decisionLabel} confirmation ${id}.`,
      [`status=${result.status}`, `executed=${result.executed}`],
    );
    return this.renderConfirmationQueueFragment(result.message, isError);
  }

  chatBootstrap(): AdminChatBootstrapResponse {
    return this.chatBootstrapService.buildBootstrap();
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
      const details = error instanceof Error ? error.message : String(error);
      return tpl.confirmationQueueFragment({
        entries: [],
        available: true,
        message: message ?? `Unable to load confirmation queue: ${details}`,
        isError: true,
      });
    }
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

  private identityLinkKey(channel: string, userId: string): string {
    return `${channel.trim().toLowerCase()}:${userId.trim().toLowerCase()}`;
  }

  private getContactIdentityLinks(contact: Contact): ContactIdentityLinkView[] {
    const links: ContactIdentityLinkView[] = [];
    const seen = new Set<string>();

    const addLink = (link: ContactIdentityLinkView): void => {
      const key = this.identityLinkKey(link.channel, link.userId);
      if (!link.channel.trim() || !link.userId.trim() || seen.has(key)) return;
      links.push(link);
      seen.add(key);
    };

    if (Array.isArray(contact.channels)) {
      for (const channel of contact.channels) {
        addLink({
          channel: channel.channel,
          userId: channel.userId,
          lastSeen: channel.lastSeen,
        });
      }
    }

    if (Array.isArray(contact.channelIdentities)) {
      for (const identity of contact.channelIdentities) {
        addLink({
          channel: identity.channel,
          userId: identity.userId,
          lastSeen: contact.lastSeen,
        });
      }
    }

    return links;
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

  // ── Events (SSE) ──

  valuesTimelinePageHtml(): string {
    const entries = this.valuesJournal.list({ limit: 250 });
    return tpl.layout('Values Timeline', tpl.valuesTimelinePage({ entries }), 'values');
  }

  eventsPageHtml(searchParams?: URLSearchParams): string {
    const filters = this.auditTimeline.parseFilters(searchParams);
    const entries = this.auditTimeline.list(filters);
    return tpl.layout('Audit Timeline', tpl.auditTimelinePage({ entries, filters }), 'events');
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
      'wyoming.session.start',
      'wyoming.session.end',
      'wyoming.connection.error',
      'wyoming.policy.violation',
      'wyoming.audit.summary',
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

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    const channelIdFilter = options.channelId?.trim() || undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

    const unsubscribers: Array<() => void> = [];
    for (const eventName of CHAT_DEBUG_EVENTS) {
      const unsub = this.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        if (res.writableEnded || res.destroyed) return;
        const payload = this.toChatDebugPayload(eventName, data);
        if (channelIdFilter && payload.channelId !== channelIdFilter) return;
        res.write(`event: chat-debug\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }

  private toChatDebugPayload(
    eventName: ChatDebugEventName,
    data: EventMap[ChatDebugEventName],
  ): AdminChatDebugEventPayload {
    switch (eventName) {
      case 'agent.turn.start': {
        const event = data as EventMap['agent.turn.start'];
        return this.buildChatDebugEvent(eventName, 'text', 'Turn started', {
          channelId: event.message.channelId,
          details: this.compactDebugDetails({
            messageId: event.message.id,
            authorId: event.message.authorId,
            authorName: event.message.authorName,
            contentPreview: truncateDebugText(event.message.content, 120),
          }),
        });
      }
      case 'agent.turn.stage': {
        const event = data as EventMap['agent.turn.stage'];
        const extras = this.extractDebugExtras(event as Record<string, unknown>, [
          'turnId',
          'channelId',
          'stage',
          'elapsedMs',
        ]);
        return this.buildChatDebugEvent(eventName, 'text', `Turn stage: ${event.stage}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            turnId: event.turnId,
            elapsedMs: event.elapsedMs,
            ...(extras ?? {}),
          }),
        });
      }
      case 'agent.turn.end': {
        const event = data as EventMap['agent.turn.end'];
        return this.buildChatDebugEvent(eventName, 'text', 'Turn completed', {
          channelId: event.message.channelId,
          details: this.compactDebugDetails({
            model: event.response.metadata.model,
            durationMs: event.response.metadata.durationMs,
            inputTokens: event.response.metadata.inputTokens,
            outputTokens: event.response.metadata.outputTokens,
            responsePreview: truncateDebugText(event.response.content, 120),
          }),
        });
      }
      case 'agent.stream.thinking': {
        const event = data as EventMap['agent.stream.thinking'];
        return this.buildChatDebugEvent(
          eventName,
          'thinking',
          truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[thinking chunk]',
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({ chars: event.text.length }),
          },
        );
      }
      case 'agent.stream.delta': {
        const event = data as EventMap['agent.stream.delta'];
        return this.buildChatDebugEvent(
          eventName,
          'text',
          truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[text chunk]',
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({ chars: event.text.length }),
          },
        );
      }
      case 'agent.tool.start': {
        const event = data as EventMap['agent.tool.start'];
        return this.buildChatDebugEvent(eventName, 'tools', `Tool start: ${event.toolName}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            shardId: event.shardId,
          }),
        });
      }
      case 'agent.tool.end': {
        const event = data as EventMap['agent.tool.end'];
        return this.buildChatDebugEvent(eventName, 'tools', `Tool end: ${event.toolName}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            isError: event.isError,
            shardId: event.shardId,
          }),
        });
      }
      case 'memory.extraction.start': {
        const event = data as EventMap['memory.extraction.start'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory extraction started', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            triggerReason: event.triggerReason,
          }),
        });
      }
      case 'memory.extraction.end': {
        const event = data as EventMap['memory.extraction.end'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory extraction completed', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            count: event.count,
            parsedCount: event.parsedCount,
            acceptedCount: event.acceptedCount,
            rejectedCount: event.rejectedCount,
            writeCount: event.writeCount,
            rejectionBreakdown: this.formatRejectionBreakdown(event.rejectionBreakdown),
          }),
        });
      }
      case 'memory.retrieval': {
        const event = data as EventMap['memory.retrieval'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory retrieval', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            count: event.count,
            candidates: event.candidates,
            ranked: event.ranked,
            returned: event.returned,
            reason: event.reason,
          }),
        });
      }
      case 'agent.error': {
        const event = data as EventMap['agent.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Agent error: ${truncateDebugText(event.error.message, 120)}`,
          {
            channelId: event.message.channelId,
            details: this.compactDebugDetails({
              messageId: event.message.id,
              authorId: event.message.authorId,
              contentPreview: truncateDebugText(event.message.content, 120),
            }),
          },
        );
      }
      case 'channel.voice.error': {
        const event = data as EventMap['channel.voice.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Voice channel error: ${truncateDebugText(event.error, 120)}`,
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({
              guildId: event.guildId,
              userId: event.userId,
            }),
          },
        );
      }
      case 'voice.turn.error': {
        const event = data as EventMap['voice.turn.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Voice turn error: ${truncateDebugText(event.error, 120)}`,
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({
              turnId: event.turnId,
              userId: event.userId,
              stage: event.stage,
              code: event.code,
            }),
          },
        );
      }
      case 'wyoming.session.start': {
        const event = data as EventMap['wyoming.session.start'];
        return this.buildChatDebugEvent(
          eventName,
          'text',
          `Wyoming session started: ${event.sessionId}`,
          {
            details: this.compactDebugDetails({
              connectionId: event.connectionId,
              sessionId: event.sessionId,
              activeSessions: event.activeSessions,
              maxSessions: event.maxSessions,
            }),
          },
        );
      }
      case 'wyoming.session.end': {
        const event = data as EventMap['wyoming.session.end'];
        const category = event.reason.includes('policy')
          || event.reason.includes('error')
          || event.reason.includes('timeout')
          ? 'errors'
          : 'text';
        return this.buildChatDebugEvent(
          eventName,
          category,
          `Wyoming session ended: ${event.sessionId}`,
          {
            details: this.compactDebugDetails({
              connectionId: event.connectionId,
              reason: event.reason,
              durationMs: event.durationMs,
              activeSessions: event.activeSessions,
            }),
          },
        );
      }
      case 'wyoming.connection.error': {
        const event = data as EventMap['wyoming.connection.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Wyoming connection error: ${truncateDebugText(event.error, 120)}`,
          {
            details: this.compactDebugDetails({
              connectionId: event.connectionId,
              code: event.code,
            }),
          },
        );
      }
      case 'wyoming.policy.violation': {
        const event = data as EventMap['wyoming.policy.violation'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Wyoming policy violation: ${event.code}`,
          {
            details: this.compactDebugDetails({
              connectionId: event.connectionId,
              code: event.code,
              scope: event.scope,
              sessionId: event.sessionId,
              eventType: event.eventType,
              limit: event.limit,
              observed: event.observed,
              action: event.action,
            }),
          },
        );
      }
      case 'wyoming.audit.summary': {
        const event = data as EventMap['wyoming.audit.summary'];
        return this.buildChatDebugEvent(
          eventName,
          event.decision === 'ALLOW' ? 'text' : 'errors',
          `Wyoming audit summary: ${event.method}`,
          {
            details: this.compactDebugDetails({
              method: event.method,
              decision: event.decision,
              error: event.error,
            }),
          },
        );
      }
      case 'system.error': {
        const event = data as EventMap['system.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `System error: ${truncateDebugText(event.error.message, 120)}`,
          {
            details: this.compactDebugDetails({
              context: event.context,
            }),
          },
        );
      }
      default: {
        return this.buildChatDebugEvent(eventName, 'text', eventName);
      }
    }
  }

  private buildChatDebugEvent(
    eventName: ChatDebugEventName,
    category: AdminChatDebugCategory,
    message: string,
    options: {
      channelId?: string;
      details?: Record<string, AdminChatDebugDetailValue>;
    } = {},
  ): AdminChatDebugEventPayload {
    const payload: AdminChatDebugEventPayload = {
      id: `chat-debug-${Date.now()}-${++this.chatDebugCounter}`,
      timestamp: Date.now(),
      event: eventName,
      category,
      message: truncateDebugText(message, MAX_DEBUG_MESSAGE_CHARS) || eventName,
    };

    if (options.channelId) {
      payload.channelId = options.channelId;
    }
    if (options.details && Object.keys(options.details).length > 0) {
      payload.details = options.details;
    }
    return payload;
  }

  private compactDebugDetails(
    details: Record<string, unknown>,
  ): Record<string, AdminChatDebugDetailValue> | undefined {
    const compact: Record<string, AdminChatDebugDetailValue> = {};
    let count = 0;
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || count >= MAX_DEBUG_DETAILS) continue;
      const normalizedValue = toDebugDetailValue(value);
      if (normalizedValue === undefined) continue;
      compact[key] = normalizedValue;
      count += 1;
    }
    return count > 0 ? compact : undefined;
  }

  private extractDebugExtras(
    data: Record<string, unknown>,
    excludedKeys: string[],
  ): Record<string, AdminChatDebugDetailValue> | undefined {
    const excluded = new Set(excludedKeys);
    const extras: Record<string, AdminChatDebugDetailValue> = {};
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (excluded.has(key) || count >= MAX_DEBUG_DETAILS) continue;
      const normalized = toDebugDetailValue(value);
      if (normalized === undefined) continue;
      extras[key] = normalized;
      count += 1;
    }
    return count > 0 ? extras : undefined;
  }

  private formatRejectionBreakdown(breakdown?: Record<string, number>): string | undefined {
    if (!breakdown) return undefined;
    const entries = Object.entries(breakdown);
    if (entries.length === 0) return undefined;
    const summary = entries
      .slice(0, 4)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ');
    return truncateDebugText(summary, 160);
  }
}
