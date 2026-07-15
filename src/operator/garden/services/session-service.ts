import { randomUUID } from 'node:crypto';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { sessionEntryToMessage } from '../../../core/agent/messages.js';
import { MESSAGE_CLASSES } from '../../../core/agent/message-classes.js';
import { resolveValidatedCrossChannelContinuityProvenance } from '../../../core/session/cross-channel-continuity-port.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { mergeAuthenticatedJournalWithSessionTail } from '../../../core/session/manager/session-tail-read-store.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { CompactionSummary } from '../../../core/session/types.js';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import type {
  CogSecAffectedMessageRange,
  CogSecCaseType,
  CogSecSeverity,
} from '../../../core/cogsec/events.js';
import { CogSecForensicArchive } from '../../../core/cogsec/forensic-archive.js';
import {
  buildCogSecLineagePreview,
  type CogSecLineageCompactionRef,
  type CogSecLineagePreview,
  type CogSecLineageSource,
} from '../../../core/cogsec/lineage.js';
import { applyCogSecRevocation } from '../../../core/cogsec/revocation.js';
import { applyCogSecRegeneration } from '../../../core/cogsec/regeneration.js';
import {
  listOperatorVisibleCogSecEvents,
  toAgentVisibleCogSecEvent,
  toOperatorVisibleCogSecEvent,
} from '../../../core/cogsec/safe-log.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import { sanitizeObservedMemory, type ObservedMemory } from '../../../core/turns/observability.js';
import {
  resolveTurnRecordMemoryCandidates,
  collectTurnRecordMemoryRefIds,
  type ObservedMemoryResolver,
} from '../../../persistence/sessions/turn-record-memory-refs.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../../core/session/compaction-audit.js';
import { resolveSessionEntryRoleEnvelopePreview } from '../../../core/session/turn-provenance.js';
import {
  classifyChannelDisclosure,
  visibilitiesShareContinuity,
} from '../../../system/trust/policy.js';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type {
  AdminContinuityProvenanceView,
  AdminCogSecCaseDraftView,
  AdminCogSecEventListData,
  AdminCogSecPreviewCounts,
  AdminCogSecRemediationApplyData,
  AdminCogSecRemediationInput,
  AdminCogSecRemediationPreviewData,
  AdminSessionRouteListData,
  AdminSessionRouteResetData,
  AdminSessionRouteResetInput,
  AdminSessionMessageOntologyView,
  AdminSessionMessagePaginationOptions,
  AdminSessionDetailData,
  AdminSessionListRow,
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionSearchData,
  AdminSessionService,
  AdminSessionTurnData,
  AdminSessionTurnDetailData,
} from './types.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
  resolveConfiguredCompanionDataDir,
} from '../../../persistence/layout.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { getLinkedContactForSession } from './contact-session-linker.js';
import { AdminSessionTurnObservabilityStore } from './session-turn-observability.js';
import type { SessionEntry } from '../../../core/session/types.js';

const DEFAULT_ADMIN_TURN_LIMIT = 50;
export const DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT = 100;
export const MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT = 200;
export const DEFAULT_ADMIN_SESSION_SEARCH_LIMIT = 25;
export const MAX_ADMIN_SESSION_SEARCH_LIMIT = 100;
const COGSEC_SAFE_SUMMARY = 'Operator-selected unsafe instruction-like content was sealed and removed from active cognition.';
const COGSEC_CASE_ID_PATTERN = /^cogsec_[A-Za-z0-9_-]+$/u;
const COGSEC_CASE_TYPES: ReadonlySet<CogSecCaseType> = new Set([
  'prompt_injection',
  'persona_poisoning',
  'memory_poisoning',
  'policy_drift',
  'content_poisoning',
  'unknown',
]);
const COGSEC_SEVERITIES: ReadonlySet<CogSecSeverity> = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Thrown by getSessionTurnDetail when the requested turn is not in the recent
 * turn window (or the turnId is blank). The session route maps this to a 404
 * instead of a 500 so a stale/expired turn expand degrades cleanly.
 */
export class AdminSessionTurnNotFoundError extends Error {
  constructor(public readonly sessionId: string, public readonly turnId: string) {
    super(`Turn "${turnId}" not found for session "${sessionId}"`);
    this.name = 'AdminSessionTurnNotFoundError';
  }
}

export class AdminSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" not found`);
    this.name = 'AdminSessionNotFoundError';
  }
}

function resolveMessageClass(value: unknown): AdminSessionMessageOntologyView['messageClass'] {
  return typeof value === 'string' && Object.values(MESSAGE_CLASSES).includes(value as never)
    ? value as AdminSessionMessageOntologyView['messageClass']
    : MESSAGE_CLASSES.outwardSpeech;
}

function buildMessageOntologyView(entry: AdminSessionMessagesData['messages'][number]): AdminSessionMessageOntologyView {
  const classified = sessionEntryToMessage(entry);

  if (classified.role === 'toolResult') {
    return {
      sessionEntryId: entry.id,
      transportRole: entry.role,
      promptRole: 'toolResult',
      semanticType: 'toolResult',
      messageClass: null,
      promptVisibility: 'prompt_visible',
      displayLabel: 'Tool result',
    };
  }

  if (classified.role === 'custom') {
    if (classified.type === 'mirror') {
      return {
        sessionEntryId: entry.id,
        transportRole: entry.role,
        promptRole: 'custom',
        semanticType: 'mirror',
        messageClass: classified.messageClass,
        promptVisibility: 'operator_only',
        displayLabel: 'Mirror note',
      };
    }

    return {
      sessionEntryId: entry.id,
      transportRole: entry.role,
      promptRole: 'custom',
      semanticType: 'systemNote',
      messageClass: classified.messageClass,
      promptVisibility: 'operator_only',
      displayLabel: 'System note',
    };
  }

  return {
    sessionEntryId: entry.id,
    transportRole: entry.role,
    promptRole: classified.role,
    semanticType: 'outwardSpeech',
    messageClass: resolveMessageClass('messageClass' in classified ? classified.messageClass : undefined),
    promptVisibility: 'prompt_visible',
    displayLabel: 'Outward speech',
  };
}

function normalizeSearchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ADMIN_SESSION_SEARCH_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_ADMIN_SESSION_SEARCH_LIMIT;
  return Math.min(value, MAX_ADMIN_SESSION_SEARCH_LIMIT);
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT;
  return Math.min(value, MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT);
}

function normalizeBeforeId(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function normalizeRequiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeMessageIds(value: readonly number[] | undefined, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  const ids = [...new Set(value.map((id, index) => normalizeOptionalPositiveInteger(id, `${field}[${index}]`)!))]
    .sort((left, right) => left - right);
  return ids.length > 0 ? ids : undefined;
}

function normalizeCaseType(value: CogSecCaseType): CogSecCaseType {
  if (COGSEC_CASE_TYPES.has(value)) return value;
  throw new Error('type must be a supported CogSec case type');
}

function normalizeSeverity(value: CogSecSeverity): CogSecSeverity {
  if (COGSEC_SEVERITIES.has(value)) return value;
  throw new Error('severity must be low, medium, high, or critical');
}

function createCogSecCaseId(now = new Date()): string {
  const compact = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return `cogsec_${compact}_${randomUUID().slice(0, 8)}`;
}

function normalizeCaseId(value: string | undefined): string {
  const caseId = value?.trim() || createCogSecCaseId();
  if (!COGSEC_CASE_ID_PATTERN.test(caseId)) {
    throw new Error('caseId must match cogsec_[A-Za-z0-9_-]+');
  }
  return caseId;
}

function previewCounts(preview: CogSecLineagePreview): AdminCogSecPreviewCounts {
  return {
    l0Rows: preview.l0Messages.length,
    projectionRows: preview.transcriptProjectionRows.length,
    memories: preview.memories.length,
    embeddingMemoryRows: preview.embeddingMemoryRows.length,
    compactionSummaries: preview.compactionSummaries.length,
    externalArtifacts: preview.externalArtifacts.length,
    lineageGaps: preview.gaps.length,
  };
}

function makeCompactionInvalidator(sessionStore: SessionStore) {
  return {
    invalidateCompactionSummaries: async (input: {
      caseId: string;
      compactionSummaries: readonly CogSecLineageCompactionRef[];
    }) => {
      const invalidatedCompactionIds: string[] = [];
      const bySession = new Map<string, number[]>();
      for (const summary of input.compactionSummaries) {
        const ids = bySession.get(summary.logicalSessionId) ?? [];
        ids.push(summary.compactionId);
        bySession.set(summary.logicalSessionId, ids);
      }
      for (const [channelId, compactionIds] of bySession.entries()) {
        const result = await sessionStore.applyCogSecCompactionInvalidations({
          channelId,
          caseId: input.caseId,
          compactionIds,
        });
        invalidatedCompactionIds.push(...result.invalidatedCompactionIds.map(id => `${channelId}:${id}`));
      }
      return { invalidatedCompactionIds };
    },
  };
}

export class AdminSessionDataService implements AdminSessionService {
  private readonly turnObservability: AdminSessionTurnObservabilityStore;
  private readonly cogSecEventStore?: CogSecEventStore;
  private readonly cogSecForensicArchive?: CogSecForensicArchive;

  constructor(private readonly deps: {
    sessionStore: SessionStore;
    sessionManager: SessionManager;
    eventBus: EventBus;
    contactStore?: ContactStorePort | null;
    memoryStore?: MemoryStorePort | null;
    config?: SubstrateConfig;
    cogSecEventStore?: CogSecEventStore;
    cogSecForensicArchive?: CogSecForensicArchive;
  }) {
    this.turnObservability = new AdminSessionTurnObservabilityStore({
      eventBus: deps.eventBus,
    });
    if (deps.cogSecEventStore) {
      this.cogSecEventStore = deps.cogSecEventStore;
    }
    if (deps.cogSecForensicArchive) {
      this.cogSecForensicArchive = deps.cogSecForensicArchive;
    }
    if ((!this.cogSecEventStore || !this.cogSecForensicArchive) && deps.config) {
      const companionDataDir = resolveConfiguredCompanionDataDir(deps.config);
      if (!this.cogSecEventStore) {
        this.cogSecEventStore = new CogSecEventStore(resolveCogSecEventsPath(companionDataDir));
      }
      if (!this.cogSecForensicArchive) {
        this.cogSecForensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionDataDir));
      }
    }
  }

  private requireCogSecEventStore(): CogSecEventStore {
    if (!this.cogSecEventStore) {
      throw new Error('CogSec event store is not configured');
    }
    return this.cogSecEventStore;
  }

  private requireCogSecForensicArchive(): CogSecForensicArchive {
    if (!this.cogSecForensicArchive) {
      throw new Error('CogSec forensic archive is not configured');
    }
    return this.cogSecForensicArchive;
  }

  private resolveActiveLogicalSessionId(sourceChannelId: string): string {
    const route = this.deps.sessionManager
      .listSessionRoutes()
      .find(candidate => candidate.sourceChannelId === sourceChannelId);
    return route?.activeLogicalSessionId ?? sourceChannelId;
  }

  private buildCogSecDraft(input: AdminCogSecRemediationInput): AdminCogSecCaseDraftView {
    const sourceChannelId = normalizeRequiredText(input.sourceChannelId, 'sourceChannelId');
    normalizeRequiredText(input.reason, 'reason');
    const actor = input.actor?.trim() || 'operator:garden';
    const activeLogicalSessionId = this.resolveActiveLogicalSessionId(sourceChannelId);
    const affectedMessageRanges = this.normalizeCogSecRanges(input, sourceChannelId, activeLogicalSessionId);
    const affectedLogicalSessionIds = [...new Set([
      ...(input.affectedLogicalSessionIds ?? []).map(sessionId => normalizeRequiredText(sessionId, 'affectedLogicalSessionIds[]')),
      ...affectedMessageRanges.map(range => range.logicalSessionId ?? activeLogicalSessionId),
    ])];
    return {
      caseId: normalizeCaseId(input.caseId),
      type: normalizeCaseType(input.type),
      severity: normalizeSeverity(input.severity),
      status: 'planned',
      sourceChannelId,
      affectedLogicalSessionIds,
      affectedMessageRanges,
      actor,
      safeSummary: COGSEC_SAFE_SUMMARY,
    };
  }

  private normalizeCogSecRanges(
    input: AdminCogSecRemediationInput,
    sourceChannelId: string,
    activeLogicalSessionId: string,
  ): CogSecAffectedMessageRange[] {
    const ranges = input.affectedMessageRanges?.map((range, index) => {
      const logicalSessionId = range.logicalSessionId?.trim() || activeLogicalSessionId;
      const normalized: CogSecAffectedMessageRange = {
        sourceChannelId: range.sourceChannelId?.trim() || sourceChannelId,
        logicalSessionId,
        ...(normalizeOptionalPositiveInteger(range.startEntryId, `affectedMessageRanges[${index}].startEntryId`) !== undefined
          ? { startEntryId: normalizeOptionalPositiveInteger(range.startEntryId, `affectedMessageRanges[${index}].startEntryId`) }
          : {}),
        ...(normalizeOptionalPositiveInteger(range.endEntryId, `affectedMessageRanges[${index}].endEntryId`) !== undefined
          ? { endEntryId: normalizeOptionalPositiveInteger(range.endEntryId, `affectedMessageRanges[${index}].endEntryId`) }
          : {}),
        ...(normalizeMessageIds(range.messageIds, `affectedMessageRanges[${index}].messageIds`)
          ? { messageIds: normalizeMessageIds(range.messageIds, `affectedMessageRanges[${index}].messageIds`) }
          : {}),
      };
      if (
        !normalized.messageIds?.length
        && normalized.startEntryId === undefined
        && normalized.endEntryId === undefined
      ) {
        throw new Error(`affectedMessageRanges[${index}] must include messageIds, startEntryId, or endEntryId`);
      }
      return normalized;
    }) ?? [];

    const messageIds = normalizeMessageIds(input.messageIds, 'messageIds');
    const startEntryId = normalizeOptionalPositiveInteger(input.startEntryId, 'startEntryId');
    const endEntryId = normalizeOptionalPositiveInteger(input.endEntryId, 'endEntryId');
    if (messageIds?.length || startEntryId !== undefined || endEntryId !== undefined) {
      ranges.push({
        sourceChannelId,
        logicalSessionId: activeLogicalSessionId,
        ...(messageIds ? { messageIds } : {}),
        ...(startEntryId !== undefined ? { startEntryId } : {}),
        ...(endEntryId !== undefined ? { endEntryId } : {}),
      });
    }

    if (ranges.length === 0) {
      throw new Error('CogSec remediation requires messageIds, startEntryId/endEntryId, or affectedMessageRanges');
    }
    return ranges;
  }

  private async buildCogSecPreviewFromDraft(draft: AdminCogSecCaseDraftView): Promise<CogSecLineagePreview> {
    const source: CogSecLineageSource = {
      caseId: draft.caseId,
      sourceChannelId: draft.sourceChannelId,
      affectedLogicalSessionIds: draft.affectedLogicalSessionIds,
      affectedMessageRanges: draft.affectedMessageRanges,
    };
    return buildCogSecLineagePreview({
      event: source,
      sessionReader: this.deps.sessionStore,
      ...(this.deps.memoryStore ? { memoryStore: this.deps.memoryStore } : {}),
    });
  }

  private verifyCompactionSummary(channelId: string, summary: CompactionSummary) {
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
        verification: 'missing_hash' as const,
        verificationDetail: 'Source hash metadata is missing in this compaction summary.',
      };
    }

    const sourceEntries = this.deps.sessionStore.getEntriesInRange(
      channelId,
      parsed.firstMessageId,
      parsed.lastMessageId,
    );
    const firstId = sourceEntries[0]?.id ?? null;
    const lastId = sourceEntries[sourceEntries.length - 1]?.id ?? null;
    if (
      sourceEntries.length !== parsed.messageCount
      || firstId !== parsed.firstMessageId
      || lastId !== parsed.lastMessageId
    ) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: parsed.sha256,
        sourceFirstMessageId: parsed.firstMessageId,
        sourceLastMessageId: parsed.lastMessageId,
        sourceMessageCount: parsed.messageCount,
        verification: 'missing_source' as const,
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
        verification: 'mismatch' as const,
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
      verification: 'verified' as const,
      verificationDetail: 'Verified against JSONL source block.',
    };
  }

  private listSessionRows(): AdminSessionListRow[] {
    const channels = this.deps.sessionStore.listChannels();
    const activityBySessionId = new Map(
      this.deps.sessionStore
        .listSessionsByRecentActivity(Number.MAX_SAFE_INTEGER)
        .map(summary => [summary.sessionId, summary]),
    );
    return channels.map((channel) => {
      const sessionActivity = activityBySessionId.get(channel.sessionId);
      return (
        typeof sessionActivity?.lastActivityAt === 'number' && Number.isFinite(sessionActivity.lastActivityAt)
      )
        ? { ...channel, lastActivityAt: sessionActivity.lastActivityAt }
        : channel;
    });
  }

  async listSessions(): Promise<AdminSessionListData> {
    return { channels: this.listSessionRows() };
  }

  async getSessionDetail(sessionId: string): Promise<AdminSessionDetailData> {
    const channel = this.listSessionRows().find(candidate => candidate.sessionId === sessionId);
    if (!channel) throw new AdminSessionNotFoundError(sessionId);

    const contacts = this.deps.contactStore ? await this.deps.contactStore.listAll() : [];
    const linkedContact = await getLinkedContactForSession({
      sessionId: channel.sessionId,
      channelId: channel.channelId,
      contacts,
      sessionStore: this.deps.sessionStore,
      contactStore: this.deps.contactStore,
    });
    return {
      channel: linkedContact
        ? {
            ...channel,
            linkedContactId: linkedContact.id,
            linkedContactName: linkedContact.displayName,
          }
        : channel,
    };
  }

  async listSessionRoutes(): Promise<AdminSessionRouteListData> {
    return {
      routes: this.deps.sessionManager.listSessionRoutes(),
      channels: this.listSessionRows(),
    };
  }

  async resetSourceChannelSession(input: AdminSessionRouteResetInput): Promise<AdminSessionRouteResetData> {
    const result = this.deps.sessionManager.resetSourceChannelSession(input);
    return {
      ok: true,
      message: `Source channel ${result.sourceChannelId} now routes to ${result.newLogicalSessionId}. Old L0 history remains available for explicit audit/search.`,
      sourceChannelId: result.sourceChannelId,
      oldLogicalSessionId: result.oldLogicalSessionId,
      newLogicalSessionId: result.newLogicalSessionId,
      route: result.route,
      retiredSession: result.retiredSession,
    };
  }

  async listCogSecEvents(): Promise<AdminCogSecEventListData> {
    const eventStore = this.requireCogSecEventStore();
    return {
      events: listOperatorVisibleCogSecEvents(eventStore.listEvents()),
    };
  }

  async previewCogSecRemediation(
    input: AdminCogSecRemediationInput,
  ): Promise<AdminCogSecRemediationPreviewData> {
    const eventStore = this.requireCogSecEventStore();
    const draft = this.buildCogSecDraft(input);
    const preview = await this.buildCogSecPreviewFromDraft(draft);
    return {
      ok: true,
      draft,
      preview,
      counts: previewCounts(preview),
      existingEvents: listOperatorVisibleCogSecEvents(eventStore.listEvents(), {
        channelIds: [draft.sourceChannelId, ...draft.affectedLogicalSessionIds],
        limit: 10,
      }),
    };
  }

  async applyCogSecRemediation(
    input: AdminCogSecRemediationInput,
  ): Promise<AdminCogSecRemediationApplyData> {
    const eventStore = this.requireCogSecEventStore();
    const forensicArchive = this.requireCogSecForensicArchive();
    const draft = this.buildCogSecDraft(input);
    if (eventStore.getEvent(draft.caseId)) {
      throw new Error(`CogSec event already exists: ${draft.caseId}`);
    }

    eventStore.createEvent({
      caseId: draft.caseId,
      type: draft.type,
      severity: draft.severity,
      status: 'applying',
      sourceChannelId: draft.sourceChannelId,
      affectedLogicalSessionIds: draft.affectedLogicalSessionIds,
      affectedMessageRanges: draft.affectedMessageRanges,
      actions: ['seal', 'tombstone', 'search_exclude', 'revoke', 'regenerate'],
      actor: draft.actor,
      safeAgentSummary: draft.safeSummary,
    });

    const tombstones = [];
    for (const range of draft.affectedMessageRanges) {
      // Sequential on purpose: each rewrite fences the shared session tail
      // (epoch bump) before and after touching the journal.
      tombstones.push(await this.deps.sessionStore.applyCogSecTombstones({
        channelId: range.logicalSessionId ?? draft.sourceChannelId,
        caseId: draft.caseId,
        eventStore,
        forensicArchive,
        ...(range.messageIds ? { messageIds: range.messageIds } : {}),
        ...(range.startEntryId !== undefined ? { startEntryId: range.startEntryId } : {}),
        ...(range.endEntryId !== undefined ? { endEntryId: range.endEntryId } : {}),
        actor: draft.actor,
      }));
    }

    const eventAfterTombstones = eventStore.getEvent(draft.caseId);
    if (!eventAfterTombstones) {
      throw new Error(`CogSec event disappeared during remediation: ${draft.caseId}`);
    }
    const preview = await buildCogSecLineagePreview({
      event: eventAfterTombstones,
      sessionReader: this.deps.sessionStore,
      ...(this.deps.memoryStore ? { memoryStore: this.deps.memoryStore } : {}),
    });

    const revocation = await applyCogSecRevocation({
      preview,
      eventStore,
      ...(this.deps.memoryStore ? { memoryStore: this.deps.memoryStore } : {}),
      compactionInvalidator: makeCompactionInvalidator(this.deps.sessionStore),
      actor: draft.actor,
    });

    const regeneration = await applyCogSecRegeneration({
      preview,
      eventStore,
      sessionStore: this.deps.sessionStore,
    });

    let routeReset: AdminCogSecRemediationApplyData['routeReset'];
    if (input.cutEpoch !== false) {
      const reset = this.deps.sessionManager.resetSourceChannelSession({
        sourceChannelId: draft.sourceChannelId,
        reason: `CogSec remediation ${draft.caseId}`,
        actor: draft.actor,
        mode: 'break_glass_quarantine',
      });
      routeReset = {
        sourceChannelId: reset.sourceChannelId,
        oldLogicalSessionId: reset.oldLogicalSessionId,
        newLogicalSessionId: reset.newLogicalSessionId,
        routeGeneration: reset.route.routeGeneration,
      };
      eventStore.appendEpochCut(draft.caseId, {
        sourceChannelId: reset.sourceChannelId,
        oldLogicalSessionId: reset.oldLogicalSessionId,
        newLogicalSessionId: reset.newLogicalSessionId,
        routeGeneration: reset.route.routeGeneration,
        cutAt: new Date().toISOString(),
      });
    }

    const finalEvent = eventStore.getEvent(draft.caseId);
    if (!finalEvent) {
      throw new Error(`CogSec event missing after remediation: ${draft.caseId}`);
    }

    const failureCount = revocation.failures.length + regeneration.failures.length;
    return {
      ok: failureCount === 0,
      message: failureCount === 0
        ? `CogSec remediation ${draft.caseId} applied.`
        : `CogSec remediation ${draft.caseId} applied with ${failureCount} follow-up item${failureCount === 1 ? '' : 's'}.`,
      event: toAgentVisibleCogSecEvent(finalEvent),
      operatorEvent: toOperatorVisibleCogSecEvent(finalEvent),
      preview,
      counts: previewCounts(preview),
      tombstones,
      revocation,
      regeneration,
      ...(routeReset ? { routeReset } : {}),
    };
  }

  async searchSessionMessages(
    sessionId: string,
    query: string,
    limit?: number,
  ): Promise<AdminSessionSearchData> {
    const boundedLimit = normalizeSearchLimit(limit);
    const normalizedQuery = query.trim();
    const hits = normalizedQuery
      ? await this.deps.sessionStore.searchByKeywords(normalizedQuery, boundedLimit, { channelId: sessionId })
      : [];
    return {
      sessionId,
      query: normalizedQuery,
      limit: boundedLimit,
      hits: hits.map(hit => ({
        messageId: hit.messageId,
        role: hit.role,
        ...(hit.authorId ? { authorId: hit.authorId } : {}),
        ...(hit.authorName ? { authorName: hit.authorName } : {}),
        content: hit.content,
        timestamp: hit.timestamp,
        snippet: hit.snippet,
      })),
    };
  }

  /**
   * Garden's newest-page read path. Authenticate the current bounded journal
   * window first, then let the shared tail fill only ids newer than that
   * window. The latest authenticated message id is also the cross-process
   * freshness checkpoint: a behind tail is rejected and repopulated even when
   * this SessionStore's process-local index predates another writer's append.
   * Redis-disabled/degraded/missing/behind tails return `null` from the store
   * and fall through to the canonical journal reader. Cursor pages stay
   * canonical because a bounded hot tail cannot prove it covers older ranges.
   */
  async getSessionMessagesForAdminRead(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions = {},
  ): Promise<AdminSessionMessagesData> {
    const beforeId = normalizeBeforeId(options.beforeId);
    if (beforeId !== null) {
      return await this.getSessionMessages(sessionId, options);
    }

    const pageLimit = normalizePageLimit(options.limit);
    const authenticatedJournalMessages = this.deps.sessionStore.getRecent(sessionId, pageLimit);
    const expectedMinEntryId = authenticatedJournalMessages.at(-1)?.id ?? null;
    const tailMessages = await this.deps.sessionStore.fetchSessionTailWindow(sessionId, {
      ...(expectedMinEntryId !== null ? { expectedMinEntryId } : {}),
    });
    const authenticatedMessages = tailMessages
      ? mergeAuthenticatedJournalWithSessionTail(authenticatedJournalMessages, tailMessages).slice(-pageLimit)
      : authenticatedJournalMessages;
    return await this.buildSessionMessages(sessionId, options, authenticatedMessages);
  }

  async getSessionMessages(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions = {},
  ): Promise<AdminSessionMessagesData> {
    return await this.buildSessionMessages(sessionId, options);
  }

  /**
   * Resolve retrieved-memory candidate refs (bead psfn-framework-jsi9) against
   * the live memory store for a batch of turn records, before their snapshots
   * are cloned into the Loom view. This is the ONLY read boundary that resolves
   * these refs — the live-agent hot path never reads `snapshot.memory`. A memory
   * that is gone or has been soft-deleted at read time heals (its candidate is
   * dropped), which is how memory deletion/redaction propagates into old turn
   * records. Records without a ref (old fat records) pass through untouched, so
   * no memory-store round-trip happens for them.
   */
  private async resolveTurnRecordMemoryRefs(records: TurnRecord[]): Promise<TurnRecord[]> {
    const ids = new Set<string>();
    for (const record of records) {
      for (const id of collectTurnRecordMemoryRefIds(record)) ids.add(id);
    }
    if (ids.size === 0) return records;
    const memoryStore = this.deps.memoryStore;
    if (!memoryStore) {
      throw new Error(
        'Cannot resolve turn-record memory candidate refs: no memoryStore is configured on the session service',
      );
    }
    const resolved = new Map<string, ObservedMemory>();
    await Promise.all(
      [...ids].map(async (id) => {
        const memory = await memoryStore.getById(id);
        // A soft-deleted memory (deletedAt set) is treated as absent so that a
        // deletion after the turn suppresses the memory instead of resurrecting
        // it from the frozen turn record.
        if (memory && memory.deletedAt === undefined) {
          resolved.set(id, sanitizeObservedMemory(memory));
        }
      }),
    );
    const resolve: ObservedMemoryResolver = (id) => resolved.get(id);
    return records.map(record => resolveTurnRecordMemoryCandidates(record, resolve));
  }

  private async buildSessionMessages(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions,
    firstPageMessages?: readonly SessionEntry[],
  ): Promise<AdminSessionMessagesData> {
    const limit = normalizePageLimit(options.limit);
    const beforeId = normalizeBeforeId(options.beforeId);
    const totalMessages = this.deps.sessionStore.count(sessionId);
    const olderThanCursor = beforeId === null
      ? null
      : this.deps.sessionStore.getEntriesBefore(sessionId, beforeId, limit + 1);
    const messages = olderThanCursor === null
      ? (firstPageMessages
          ? firstPageMessages.slice(-limit)
          : this.deps.sessionStore.getRecent(sessionId, limit))
      : olderThanCursor.slice(-limit);
    const hasMoreOlder = olderThanCursor === null
      ? totalMessages > messages.length
      : olderThanCursor.length > messages.length;
    const nextBeforeId = hasMoreOlder ? (messages[0]?.id ?? null) : null;
    const messageOntologyViews = messages.map(buildMessageOntologyView);
    const sessionActivity = this.deps.sessionStore.getSessionActivity(sessionId);
    const channelId = messages.length > 0
      ? messages[0]!.channelId
      : (sessionActivity?.channelId ?? sessionId);
    // Stored entry visibility decodes through the read-boundary decoder
    // (legacy 'semi_private'/'broadcast' records map onto ChannelPrivacy).
    const currentVisibility: ChannelPrivacy = decodeStoredChannelVisibility(messages[0]?.channelVisibility)
      ?? classifyChannelDisclosure(channelId).channelPrivacy;
    // messagesOnly drops everything heavy (turns, previews, compaction).
    // includeTurns=false keeps compaction summaries but drops the up-to-50 full
    // turn snapshots and role-envelope previews; the session browser uses it so
    // its initial page stays small and pulls per-turn detail on demand.
    const includeTurnDetail = !options.messagesOnly && options.includeTurns !== false;
    const roleEnvelopePreviews = includeTurnDetail
      ? messages.flatMap((entry) => {
        const preview = resolveSessionEntryRoleEnvelopePreview(entry);
        return preview ? [{ sessionEntryId: entry.id, preview }] : [];
      })
      : [];
    const turnRecords = includeTurnDetail
      ? await this.resolveTurnRecordMemoryRefs(
        this.deps.sessionStore.getRecentTurnRecords(sessionId, DEFAULT_ADMIN_TURN_LIMIT),
      )
      : [];
    const turns = turnRecords.map((record) => {
      const turnData = this.turnObservability.buildTurnData(record);
      return {
        ...turnData,
        continuityProvenance: buildContinuityProvenanceViews(
          record.turnId,
          record.channelId,
          currentVisibility,
          turnData.snapshot?.sessionContext?.continuityEntries ?? [],
        ),
      };
    });
    const compactionAuditViews = options.messagesOnly
      ? []
      : this.deps.sessionStore
        .getCompactionSummaries(sessionId)
        .slice()
        .sort((left, right) => right.id - left.id)
        .map(summary => this.verifyCompactionSummary(sessionId, summary));
    return {
      sessionId,
      channelId,
      messages,
      pagination: {
        limit,
        beforeId,
        nextBeforeId,
        hasMoreOlder,
        totalMessages,
        returnedMessages: messages.length,
      },
      messageOntologyViews,
      roleEnvelopePreviews,
      compactionAuditViews,
      turns,
    };
  }

  /**
   * Lazily resolve a single turn's full snapshot detail, bounded to one turn so
   * the session browser can pull turn data on expand without shipping the
   * up-to-50 snapshots the list endpoint would otherwise attach. Searches the
   * same recent-turn window the list uses; a turnId outside that window (or an
   * unknown one) fails closed with AdminSessionTurnNotFoundError so the route
   * can answer 404 rather than silently returning an empty turn.
   */
  async getSessionTurnDetail(sessionId: string, turnId: string): Promise<AdminSessionTurnDetailData> {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      throw new AdminSessionTurnNotFoundError(sessionId, turnId);
    }
    const record = this.deps.sessionStore
      .getRecentTurnRecords(sessionId, DEFAULT_ADMIN_TURN_LIMIT)
      .find(candidate => candidate.turnId === normalizedTurnId);
    if (!record) {
      throw new AdminSessionTurnNotFoundError(sessionId, normalizedTurnId);
    }
    // Decode channel visibility from a single recent entry (bounded read),
    // mirroring the list endpoint's fallback to channel-disclosure policy.
    const recentEntry = this.deps.sessionStore.getRecent(sessionId, 1).at(0);
    const currentVisibility: ChannelPrivacy = decodeStoredChannelVisibility(recentEntry?.channelVisibility)
      ?? classifyChannelDisclosure(record.channelId).channelPrivacy;
    const [resolvedRecord] = await this.resolveTurnRecordMemoryRefs([record]);
    const turnData = this.turnObservability.buildTurnData(resolvedRecord!);
    const turn: AdminSessionTurnData = {
      ...turnData,
      continuityProvenance: buildContinuityProvenanceViews(
        record.turnId,
        record.channelId,
        currentVisibility,
        turnData.snapshot?.sessionContext?.continuityEntries ?? [],
      ),
    };
    return { sessionId, channelId: record.channelId, turn };
  }
}

function buildContinuityProvenanceViews(
  turnId: string,
  currentChannelId: string,
  currentVisibility: ChannelPrivacy,
  continuityEntries: readonly SessionEntry[],
): AdminContinuityProvenanceView[] {
  const provenance: AdminContinuityProvenanceView[] = [];

  for (const entry of continuityEntries) {
    const continuity = resolveValidatedCrossChannelContinuityProvenance(
      entry,
      currentChannelId,
    );
    if (!continuity) continue;

    const carriedAcrossChannels = continuity.sourceChannelId !== currentChannelId;
    const sourceVisibility = continuity.sourceVisibility;
    const visibilityCompatible = visibilitiesShareContinuity(
      { channelPrivacy: sourceVisibility, broadcast: false },
      { channelPrivacy: currentVisibility, broadcast: false },
    );

    provenance.push({
      sessionEntryId: entry.id,
      turnId,
      continuityUserId: continuity.continuityUserId,
      sourceChannelId: continuity.sourceChannelId,
      sourceVisibility,
      currentChannelId,
      currentVisibility,
      carriedAcrossChannels: carriedAcrossChannels && visibilityCompatible,
    });
  }

  return provenance;
}
