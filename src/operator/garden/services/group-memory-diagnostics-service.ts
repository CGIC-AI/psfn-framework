import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import { inferSessionChannelType } from '../../../core/session/session-id.js';
import type { ChannelType } from '../../../shared/contracts/runtime.js';
import { resolvePreferredContactName } from '../../../core/contacts/preferred-name.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import { isInternalMemoryArtifact } from '../../../faculties/memory/internal-artifacts.js';
import {
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  buildGroupMemoryRangePlan,
  type GroupMemoryWatermarkStorePort,
} from '../../../faculties/memory/extraction/group-ranges.js';
import {
  classifyGroupMemoryChannel,
  resolveGroupMemorySettingsForChannel,
} from '../../../faculties/memory/extraction/group-classifier.js';
import { selectGroupMemorySalienceCandidates } from '../../../faculties/memory/extraction/group-salience.js';
import {
  GroupMemoryBackfillRunner,
  type GroupMemoryBackfillExtractorPort,
  type GroupMemoryBackfillInput,
  type GroupMemoryBackfillResult,
} from '../../../faculties/memory/extraction/group-backfill.js';
import type {
  AdminGroupMemoryCandidateSpanView,
  AdminGroupMemoryChannelDiagnostics,
  AdminGroupMemoryContactCoverage,
  AdminGroupMemoryContactProfileStatus,
  AdminGroupMemoryDiagnosticsListData,
  AdminGroupMemoryExtractionTelemetry,
  AdminGroupMemoryService,
} from './types.js';

const GROUP_MEMORY_EXTRACTION_TRIGGERS = new Set<string>([
  'observed_count',
  'observed_time',
  'direct_mention',
  'high_salience',
  'backlog_lag',
  'operator_backfill',
  'manual',
  'response_turn',
]);

export interface AdminGroupMemoryDataServiceOptions {
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  sessionStore: SessionStore;
  memoryStore: MemoryStorePort;
  contactStore?: ContactStorePort | null;
  watermarkStore: GroupMemoryWatermarkStorePort;
  memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  eventBus?: Pick<EventBus, 'on'> | null;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
}

export class AdminGroupMemoryDataService implements AdminGroupMemoryService {
  private readonly lastExtractionByChannel = new Map<string, AdminGroupMemoryExtractionTelemetry>();
  private readonly backfillRunner: GroupMemoryBackfillRunner;

  constructor(private readonly deps: AdminGroupMemoryDataServiceOptions) {
    this.backfillRunner = new GroupMemoryBackfillRunner({
      ...(deps.groupMemory ? { groupMemory: deps.groupMemory } : {}),
      ...(deps.channelGroupMemory ? { channelGroupMemory: deps.channelGroupMemory } : {}),
      sessionReader: deps.sessionStore,
      watermarkStore: deps.watermarkStore,
      ...(deps.memoryExtractor ? { memoryExtractor: deps.memoryExtractor } : {}),
      ...(deps.contactStore ? { contactStore: deps.contactStore } : {}),
      companionNames: deps.companionNames ?? [],
      companionAuthorIds: deps.companionAuthorIds ?? [],
    });
    deps.eventBus?.on('memory.extraction.end', (event) => {
      if (!isGroupExtractionTelemetry(event)) return;
      this.lastExtractionByChannel.set(event.channelId, event);
    });
  }

  async listGroupMemoryDiagnostics(): Promise<AdminGroupMemoryDiagnosticsListData> {
    const diagnostics = (
      await Promise.all(
        this.deps.sessionStore
          .listChannels()
          .map(channel => this.buildChannelDiagnostics(channel.channelId, channel.sessionId, channel.messageCount)),
      )
    )
      .filter((item): item is AdminGroupMemoryChannelDiagnostics => item !== null)
      .sort((left, right) => {
        const activityDelta = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
        if (activityDelta !== 0) return activityDelta;
        return left.channelId.localeCompare(right.channelId);
      });

    const reasonCounts: Record<string, number> = {};
    for (const diagnostic of diagnostics) {
      reasonCounts[diagnostic.classification.reason] =
        (reasonCounts[diagnostic.classification.reason] ?? 0) + 1;
    }

    return {
      channels: diagnostics,
      reasonCounts,
    };
  }

  async getGroupMemoryChannelDiagnostics(
    channelId: string,
  ): Promise<AdminGroupMemoryChannelDiagnostics | null> {
    const channel = this.deps.sessionStore
      .listChannels()
      .find(candidate => candidate.channelId === channelId || candidate.sessionId === channelId);
    return this.buildChannelDiagnostics(
      channel?.channelId ?? channelId,
      channel?.sessionId,
      channel?.messageCount,
    );
  }

  async runGroupMemoryBackfill(
    channelId: string,
    input: GroupMemoryBackfillInput,
  ): Promise<GroupMemoryBackfillResult> {
    return this.backfillRunner.run(channelId, input);
  }

  private async buildChannelDiagnostics(
    channelId: string,
    sessionId?: string,
    messageCount?: number,
  ): Promise<AdminGroupMemoryChannelDiagnostics | null> {
    const channelType = resolveRuntimeChannelType(channelId);
    if (!channelType) return null;

    const resolved = resolveGroupMemorySettingsForChannel({
      channelId,
      ...(this.deps.groupMemory ? { base: this.deps.groupMemory } : {}),
      ...(this.deps.channelGroupMemory ? { channelConfig: this.deps.channelGroupMemory } : {}),
    });
    const settings = resolved.settings;
    if (!settings.telemetry.exposeGardenDiagnostics) return null;

    const recentEntries = await this.deps.sessionStore.getRecent(
      channelId,
      settings.autoDetection.recentParticipantWindowMessages,
    );
    const classification = await classifyGroupMemoryChannel({
      channelId,
      channelType,
      groupMemory: settings,
      recentEntries,
      ...(this.deps.contactStore ? { contactStore: this.deps.contactStore } : {}),
      ...(this.deps.companionAuthorIds ? { companionAuthorIds: this.deps.companionAuthorIds } : {}),
    });
    const plan = buildGroupMemoryRangePlan({
      channelId,
      sessionReader: this.deps.sessionStore,
      watermarkStore: this.deps.watermarkStore,
      settings,
    });
    const firstChunk = plan.chunks.length > 0 ? plan.chunks[0] : null;
    const salience = firstChunk
      ? selectGroupMemorySalienceCandidates({
        chunk: firstChunk,
        settings,
        companionNames: this.deps.companionNames ?? [],
        companionAuthorIds: this.deps.companionAuthorIds ?? [],
      })
      : null;
    const channelMemories = await this.listChannelMemories(channelId, settings);
    const contactsById = await this.buildContactsById();
    const coverage = await this.buildCoverage({
      memories: channelMemories,
      participants: classification.recentParticipants,
      contactsById,
      settings,
    });
    const activity = this.deps.sessionStore.getSessionActivity(sessionId ?? channelId);

    return {
      channelId,
      ...(sessionId ? { sessionId } : {}),
      channelType,
      messageCount: messageCount ?? activity?.messageCount ?? recentEntries.length,
      ...(activity?.lastActivityAt ? { lastActivityAt: activity.lastActivityAt } : {}),
      resolvedConfig: settings,
      classification: {
        mode: classification.mode,
        reason: classification.reason,
        topology: classification.topology,
        configuredMemoryMode: classification.configuredMemoryMode,
        configuredMemoryModeSource: classification.configuredMemoryModeSource,
        ...(classification.manualOverrideSource
          ? { manualOverrideSource: classification.manualOverrideSource }
          : {}),
        recentParticipantCount: classification.recentParticipantCount,
        recentParticipantContactIds: classification.recentParticipantContactIds,
        recentParticipants: classification.recentParticipants,
        participantWindow: classification.participantWindow,
      },
      watermark: plan.watermark,
      range: {
        headMessageId: plan.headMessageId,
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        plannedChunkCount: plan.chunks.length,
        hasDeferredBacklog: plan.hasDeferredBacklog,
        ...(plan.deferredAfterMessageId !== undefined
          ? { deferredAfterMessageId: plan.deferredAfterMessageId }
          : {}),
        ...(firstChunk
          ? {
            firstChunk: {
              spanStartMessageId: firstChunk.spanStartMessageId,
              spanEndMessageId: firstChunk.spanEndMessageId,
              contextStartMessageId: firstChunk.contextStartMessageId,
              contextEndMessageId: firstChunk.contextEndMessageId,
              newEntryCount: firstChunk.newEntryCount,
              overlapEntryCount: firstChunk.overlapEntryCount,
              estimatedTokens: firstChunk.estimatedTokens,
            },
          }
          : {}),
      },
      salience: salience
        ? {
          telemetry: salience.telemetry,
          candidateSpans: salience.candidateSpans.map(span => ({
            startMessageId: span.startMessageId,
            endMessageId: span.endMessageId,
            contextStartMessageId: span.contextStartMessageId,
            contextEndMessageId: span.contextEndMessageId,
            sourceMessageIds: span.sourceMessageIds,
            newSourceMessageIds: span.newSourceMessageIds,
            contextMessageIds: span.contextMessageIds,
            score: span.score,
            reasons: span.reasons,
            contributingAuthorIds: span.contributingAuthorIds,
            contributingContactIds: resolveContributingContactIds(
              span.contributingAuthorIds,
              classification.recentParticipants,
            ),
          } satisfies AdminGroupMemoryCandidateSpanView)),
        }
        : null,
      lastExtraction: this.lastExtractionByChannel.get(channelId) ?? null,
      coverage,
      privacy: {
        rawTranscriptTextIncluded: false,
        memoryTextIncluded: false,
      },
    };
  }

  private async listChannelMemories(
    channelId: string,
    settings: GroupMemorySettings,
  ): Promise<PurrMemory[]> {
    return (await this.deps.memoryStore.getAllActiveMemories(settings.telemetry.maxDiagnosticMemoryScan))
      .filter(isActiveMemory)
      .filter(memory => !isInternalMemoryArtifact(memory))
      .filter(memory => memory.provenance?.channelId === channelId || memory.sourceRef.startsWith(`${channelId}:`));
  }

  private async buildContactsById(): Promise<Map<string, Contact>> {
    const contacts = await this.deps.contactStore?.listAll();
    return new Map((contacts ?? []).map(contact => [contact.id, contact]));
  }

  private async buildCoverage(params: {
    memories: readonly PurrMemory[];
    participants: readonly { contactId?: string; entryIds: number[] }[];
    contactsById: ReadonlyMap<string, Contact>;
    settings: GroupMemorySettings;
  }): Promise<AdminGroupMemoryChannelDiagnostics['coverage']> {
    const recentMessageCounts = new Map<string, number>();
    const contactIds = new Set<string>();
    for (const participant of params.participants) {
      if (!participant.contactId) continue;
      contactIds.add(participant.contactId);
      recentMessageCounts.set(
        participant.contactId,
        (recentMessageCounts.get(participant.contactId) ?? 0) + participant.entryIds.length,
      );
    }
    for (const memory of params.memories) {
      for (const contactId of extractMemoryContactIds(memory)) {
        contactIds.add(contactId);
      }
    }

    const perContact = await Promise.all(
      [...contactIds].sort().map(contactId => this.buildContactCoverage({
        contactId,
        memories: params.memories,
        recentMessageCount: recentMessageCounts.get(contactId) ?? 0,
        contact: params.contactsById.get(contactId),
        settings: params.settings,
      })),
    );

    return {
      channelMemoryCount: params.memories.length,
      activeMemoryCount: params.memories.length,
      highSensitivityMemoryCount: params.memories
        .filter(memory => memory.sensitivity === 'intimate' || memory.sensitivity === 'confidential')
        .length,
      perContact,
    };
  }

  private async buildContactCoverage(params: {
    contactId: string;
    memories: readonly PurrMemory[];
    recentMessageCount: number;
    contact?: Contact;
    settings: GroupMemorySettings;
  }): Promise<AdminGroupMemoryContactCoverage> {
    const sourceMemoryCount = params.memories
      .filter(memory => memory.provenance?.sourceContactId === params.contactId)
      .length;
    const subjectMemoryCount = params.memories
      .filter(memory => memory.provenance?.subjectContactId === params.contactId)
      .length;
    const routedMemoryCount = params.memories
      .filter(memory => memory.contactId === params.contactId || memory.provenance?.routedContactId === params.contactId)
      .length;
    const totalAttributedMemoryCount = params.memories
      .filter(memory => extractMemoryContactIds(memory).includes(params.contactId))
      .length;
    const profile = await this.deps.memoryStore.getContactProfile(params.contactId);
    const profileStatus = resolveProfileStatus({
      profilePresent: Boolean(profile),
      attributedMemoryCount: totalAttributedMemoryCount,
      recentMessageCount: params.recentMessageCount,
      minSourceMemories: params.settings.profileRefresh.minSourceMemories,
    });

    return {
      contactId: params.contactId,
      ...(params.contact
        ? { displayName: resolvePreferredContactName(params.contact, params.contact.displayName) }
        : {}),
      recentMessageCount: params.recentMessageCount,
      sourceMemoryCount,
      subjectMemoryCount,
      routedMemoryCount,
      totalAttributedMemoryCount,
      profileStatus,
      ...(profile ? { profileSourceMemoryCount: profile.sourceMemoryIds.length } : {}),
      ...(profile ? { profileUpdatedAt: profile.updatedAt } : {}),
      ...(profileStatus === 'insufficient_source_memories'
        ? { skipReason: 'insufficient_source_memories' }
        : {}),
      ...(profileStatus === 'profile_missing'
        ? { skipReason: 'profile_refresh_not_observed_or_pending' }
        : {}),
    };
  }
}

function resolveRuntimeChannelType(channelId: string): ChannelType | null {
  const inferred = inferSessionChannelType(channelId);
  return inferred && inferred !== 'subagent' ? inferred : null;
}

function isActiveMemory(memory: PurrMemory): boolean {
  return memory.supersededBy == null && memory.deletedAt == null;
}

function extractMemoryContactIds(memory: PurrMemory): string[] {
  return [
    memory.contactId,
    memory.provenance?.triggerContactId,
    memory.provenance?.routedContactId,
    memory.provenance?.sourceContactId,
    memory.provenance?.subjectContactId,
  ]
    .filter((contactId): contactId is string => Boolean(contactId))
    .filter((contactId, index, all) => all.indexOf(contactId) === index);
}

function resolveProfileStatus(params: {
  profilePresent: boolean;
  attributedMemoryCount: number;
  recentMessageCount: number;
  minSourceMemories: number;
}): AdminGroupMemoryContactProfileStatus {
  if (params.profilePresent) return 'profile_ready';
  if (params.attributedMemoryCount >= params.minSourceMemories) return 'profile_missing';
  if (params.attributedMemoryCount > 0 || params.recentMessageCount > 0) {
    return 'insufficient_source_memories';
  }
  return 'no_activity';
}

function resolveContributingContactIds(
  authorIds: readonly string[],
  participants: readonly { authorId?: string; contactId?: string }[],
): string[] {
  const authorIdSet = new Set(authorIds);
  return participants
    .filter(participant => participant.authorId && authorIdSet.has(participant.authorId))
    .map(participant => participant.contactId)
    .filter((contactId): contactId is string => Boolean(contactId))
    .filter((contactId, index, all) => all.indexOf(contactId) === index)
    .sort();
}

function isGroupExtractionTelemetry(
  event: EventMap['memory.extraction.end'],
): event is AdminGroupMemoryExtractionTelemetry {
  const reason = event.triggerReason?.trim();
  return !reason || GROUP_MEMORY_EXTRACTION_TRIGGERS.has(reason);
}
