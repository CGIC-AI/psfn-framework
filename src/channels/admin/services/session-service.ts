import type { ContactStore } from '../../../contacts/store.js';
import type { EventBus } from '../../../event-bus.js';
import type { SessionManager } from '../../../session/manager.js';
import type { SessionStore } from '../../../session/store.js';
import type { CompactionSummary } from '../../../session/types.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../../session/compaction-audit.js';
import { resolveSessionEntryRoleEnvelopePreview } from '../../../session/turn-provenance.js';
import type {
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionService,
} from './types.js';
import { getLinkedContactForSession } from './contact-session-linker.js';
import { AdminSessionTurnObservabilityStore } from './session-turn-observability.js';

const DEFAULT_ADMIN_TURN_LIMIT = 50;

export class AdminSessionDataService implements AdminSessionService {
  private readonly turnObservability: AdminSessionTurnObservabilityStore;

  constructor(private readonly deps: {
    sessionStore: SessionStore;
    sessionManager: SessionManager;
    eventBus: EventBus;
    contactStore?: ContactStore | null;
  }) {
    this.turnObservability = new AdminSessionTurnObservabilityStore({
      eventBus: deps.eventBus,
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

  listSessions(): AdminSessionListData {
    const channels = this.deps.sessionStore.listChannels();
    const contacts = this.deps.contactStore?.listAll() ?? [];
    return {
      channels: channels.map(channel => {
        const lastEntry = this.deps.sessionStore.getLastEntry(channel.channelId);
        const lastActivityAt = lastEntry
          ? (typeof lastEntry.timestamp === 'number'
            ? lastEntry.timestamp
            : Date.parse(String(lastEntry.timestamp)))
          : undefined;
        const channelWithActivity = (
          typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt)
        )
          ? { ...channel, lastActivityAt }
          : channel;

        const linkedContact = getLinkedContactForSession({
          channelId: channel.channelId,
          contacts,
          sessionStore: this.deps.sessionStore,
          contactStore: this.deps.contactStore,
        });
        if (!linkedContact) return channelWithActivity;
        return {
          ...channelWithActivity,
          linkedContactId: linkedContact.id,
          linkedContactName: linkedContact.displayName,
        };
      }),
    };
  }

  getSessionMessages(channelId: string): AdminSessionMessagesData {
    const messages = this.deps.sessionManager.getRecentMessages(channelId, 100);
    const roleEnvelopePreviews = messages.flatMap((entry) => {
      const preview = resolveSessionEntryRoleEnvelopePreview(entry);
      return preview ? [{ sessionEntryId: entry.id, preview }] : [];
    });
    const turns = this.deps.sessionStore
      .getRecentTurnRecords(channelId, DEFAULT_ADMIN_TURN_LIMIT)
      .map(record => this.turnObservability.buildTurnData(record));
    const compactionAuditViews = this.deps.sessionStore
      .getCompactionSummaries(channelId)
      .slice()
      .sort((left, right) => right.id - left.id)
      .map(summary => this.verifyCompactionSummary(channelId, summary));
    return {
      channelId,
      messages,
      roleEnvelopePreviews,
      compactionAuditViews,
      turns,
    };
  }
}
