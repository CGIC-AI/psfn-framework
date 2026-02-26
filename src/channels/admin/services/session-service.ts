import type { ContactStore } from '../../../contacts/store.js';
import type { SessionManager } from '../../../session/manager.js';
import type { SessionStore } from '../../../session/store.js';
import type { CompactionSummary } from '../../../session/types.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../../session/compaction-audit.js';
import type {
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionService,
} from './types.js';
import { getLinkedContactForSession } from './contact-session-linker.js';

export class AdminSessionDataService implements AdminSessionService {
  constructor(private readonly deps: {
    sessionStore: SessionStore;
    sessionManager: SessionManager;
    contactStore?: ContactStore | null;
  }) {}

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
        const linkedContact = getLinkedContactForSession({
          channelId: channel.channelId,
          contacts,
          sessionStore: this.deps.sessionStore,
          contactStore: this.deps.contactStore,
        });
        if (!linkedContact) return channel;
        return {
          ...channel,
          linkedContactId: linkedContact.id,
          linkedContactName: linkedContact.displayName,
        };
      }),
    };
  }

  getSessionMessages(channelId: string): AdminSessionMessagesData {
    const messages = this.deps.sessionManager.getRecentMessages(channelId, 100);
    const compactionAuditViews = this.deps.sessionStore
      .getCompactionSummaries(channelId)
      .slice()
      .sort((left, right) => right.id - left.id)
      .map(summary => this.verifyCompactionSummary(channelId, summary));
    return {
      channelId,
      messages,
      compactionAuditViews,
    };
  }
}
