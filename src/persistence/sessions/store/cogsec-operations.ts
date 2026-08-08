import type { JournalEntry, SessionEntry } from '../../../core/session/types.js';
import type { CogSecAction, CogSecEventStore } from '../../../core/cogsec/events.js';
import type { CogSecForensicArchive } from '../../../core/cogsec/forensic-archive.js';
import {
  buildCogSecInvalidatedSummaryContent,
  buildCogSecTombstoneContent,
  buildCogSecTombstoneMetadata,
  isCogSecInvalidatedSummaryContent,
  normalizeCogSecCaseId,
  parseCogSecTombstoneCaseId,
} from '../../../core/cogsec/tombstones.js';
import {
  buildCogSecInvalidatedCompactionJournalEntry,
  buildCogSecTombstoneJournalEntry,
  isSelectedCogSecMessage,
  normalizeCogSecRegeneratedSummary,
  normalizeCogSecSelector,
  normalizeEntryId,
  uniqueStrings,
} from './cogsec-journal-helpers.js';
import { loadSessionJournalChain, readSessionJournalChain } from './session-chain-cache.js';
import type { SessionJournalRuntime } from './journal-runtime.js';
import type { ChannelCache, ChannelIndexEntry } from '../store-primitives.js';
import { snapshotIndexEntry } from './channel-index.js';

type CogSecEventMetadataStore = Pick<CogSecEventStore, 'getEvent' | 'updateEvent'>;

type CogSecForensicArchiveWriter = Pick<CogSecForensicArchive, 'sealArtifact'>;

export interface CogSecL0TombstoneOptions {
  channelId: string;
  caseId: string;
  eventStore: CogSecEventMetadataStore;
  forensicArchive: CogSecForensicArchiveWriter;
  messageIds?: readonly number[];
  startEntryId?: number;
  endEntryId?: number;
  actor?: string;
  timestamp?: number;
}

export interface CogSecL0TombstoneResult {
  caseId: string;
  sourceChannelId: string;
  logicalSessionId: string;
  tombstonedL0RowCount: number;
  tombstonedMessageIds: number[];
  sealedForensicPayloadRef?: string;
  sealedForensicPayloadHash?: string;
}

interface CogSecTombstoneChannelDiagnostic {
  channelId: string;
  rowCount: number;
  messageIds: number[];
}

export interface CogSecTombstoneDiagnostic {
  caseId: string;
  rowCount: number;
  channels: CogSecTombstoneChannelDiagnostic[];
}

export interface CogSecCompactionInvalidationOptions {
  channelId: string;
  caseId: string;
  compactionIds: readonly number[];
}

export interface CogSecCompactionInvalidationResult {
  caseId: string;
  channelId: string;
  invalidatedCompactionIds: number[];
}

interface CogSecCompactionRegenerationSummary {
  compactionId: number;
  summary: string;
}

export interface CogSecCompactionRegenerationOptions {
  channelId: string;
  caseId: string;
  summaries: readonly CogSecCompactionRegenerationSummary[];
}

export interface CogSecCompactionRegenerationResult {
  caseId: string;
  channelId: string;
  regeneratedCompactionIds: number[];
  skippedCompactionIds: number[];
}

export interface SessionCogSecOperationsContext {
  readonly journalRuntime: SessionJournalRuntime;
  bumpSessionTailEpoch(channelId: string, reason: string): Promise<void>;
  withPostRewriteTailFence<T>(
    channelId: string,
    reason: string,
    body: (markRewritten: () => void) => T,
  ): Promise<T>;
  withLockedExistingChannelWrite<T>(
    channelId: string,
    writer: (cache: ChannelCache, renewLease: () => void) => T,
  ): T | null;
  readJournalChain(cache: ChannelCache): {
    archives: ReturnType<SessionJournalRuntime['openArchive']>[];
    entriesByArchive: JournalEntry[][];
    entries: JournalEntry[];
  };
  loadJournalChain(cache: ChannelCache): ChannelCache;
  syncTranscriptProjectionForChannel(
    channelId: string,
    entries: readonly SessionEntry[],
    options?: { redaction?: boolean },
  ): void;
  resolveCacheSessionKey(cache: ChannelCache): string;
  setChannelCache(sessionKey: string, cache: ChannelCache): void;
  upsertChannelIndex(sessionKey: string, entry: ChannelIndexEntry): void;
}

export class SessionCogSecOperations {
  constructor(private readonly context: SessionCogSecOperationsContext) {}

  async applyCogSecTombstones(options: CogSecL0TombstoneOptions): Promise<CogSecL0TombstoneResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const event = options.eventStore.getEvent(caseId);
    if (!event) {
      throw new Error(`CogSec event not found: ${caseId}`);
    }
    const selector = normalizeCogSecSelector(options);
    const timestamp = options.timestamp ?? Date.now();
    const redactedAt = new Date(timestamp).toISOString();

    await this.context.bumpSessionTailEpoch(options.channelId, 'cogsec_tombstone_rewrite');
    const result = await this.context.withPostRewriteTailFence(
      options.channelId,
      'cogsec_tombstone_rewrite',
      (markRewritten) => this.context.withLockedExistingChannelWrite(options.channelId, (cache, renewLease) => {
        const journalChain = readSessionJournalChain(this.context.journalRuntime, cache);
        const rawEntries = journalChain.entries;
        const selectedRows = rawEntries.filter(entry => isSelectedCogSecMessage(entry, selector));
        const selectedMessageIds = selectedRows.map(entry => entry.id);
        if (selectedRows.length === 0) {
          return {
            caseId,
            sourceChannelId: event.sourceChannelId,
            logicalSessionId: cache.channelId,
            tombstonedL0RowCount: 0,
            tombstonedMessageIds: [],
          } satisfies CogSecL0TombstoneResult;
        }

        const sealed = options.forensicArchive.sealArtifact({
          caseId,
          kind: 'l0_rows',
          sourceChannelId: event.sourceChannelId,
          logicalSessionId: cache.channelId,
          payload: {
            caseId,
            sourceChannelId: event.sourceChannelId,
            logicalSessionId: cache.channelId,
            selectedMessageIds,
            rows: selectedRows,
          },
        });

        const tombstoneContent = buildCogSecTombstoneContent(caseId);
        const tombstoneMetadata = buildCogSecTombstoneMetadata({
          caseId,
          redactedAt,
          actor: options.actor,
        });
        const selectedIdSet = new Set(selectedMessageIds);
        const rewrittenEntriesByArchive = journalChain.entriesByArchive.map(entries => (
          entries.map(entry => (
            entry.type === 'message' && selectedIdSet.has(entry.id)
              ? buildCogSecTombstoneJournalEntry(entry, tombstoneContent, tombstoneMetadata)
              : entry
          ))
        ));

        this.context.journalRuntime.rewriteJournalEntryChain(
          journalChain.archives,
          rewrittenEntriesByArchive,
          renewLease,
        );
        markRewritten();
        const reloaded = loadSessionJournalChain(this.context.journalRuntime, cache);
        const sessionKey = this.context.resolveCacheSessionKey(cache);
        this.context.setChannelCache(sessionKey, reloaded);
        this.context.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));
        this.context.syncTranscriptProjectionForChannel(reloaded.channelId, reloaded.entries, { redaction: true });

        const currentEvent = options.eventStore.getEvent(caseId) ?? event;
        const affectedMessageRanges = [
          ...currentEvent.affectedMessageRanges,
          {
            sourceChannelId: event.sourceChannelId,
            logicalSessionId: cache.channelId,
            messageIds: selectedMessageIds,
          },
        ];
        const nextActions = uniqueStrings([
          ...currentEvent.actions,
          'seal',
          'tombstone',
        ] satisfies CogSecAction[]);

        options.eventStore.updateEvent(caseId, {
          affectedLogicalSessionIds: uniqueStrings([
            ...currentEvent.affectedLogicalSessionIds,
            cache.channelId,
          ]),
          affectedMessageRanges,
          sealedForensicPayloadRefs: uniqueStrings([
            ...currentEvent.sealedForensicPayloadRefs,
            sealed.ref,
          ]),
          sealedForensicPayloadHashes: uniqueStrings([
            ...currentEvent.sealedForensicPayloadHashes,
            sealed.sha256,
          ]),
          tombstonedL0RowCount: currentEvent.tombstonedL0RowCount + selectedRows.length,
          actions: nextActions,
          resultCounters: {
            ...currentEvent.resultCounters,
            sealedArtifacts: (currentEvent.resultCounters.sealedArtifacts ?? 0) + 1,
            tombstonedL0Rows: (currentEvent.resultCounters.tombstonedL0Rows ?? 0) + selectedRows.length,
          },
        });

        return {
          caseId,
          sourceChannelId: event.sourceChannelId,
          logicalSessionId: cache.channelId,
          tombstonedL0RowCount: selectedRows.length,
          tombstonedMessageIds: selectedMessageIds,
          sealedForensicPayloadRef: sealed.ref,
          sealedForensicPayloadHash: sealed.sha256,
        } satisfies CogSecL0TombstoneResult;
      }),
    );

    if (!result) {
      throw new Error(`Session channel not found for CogSec tombstone: ${options.channelId}`);
    }
    return result;
  }

  async applyCogSecCompactionInvalidations(
    options: CogSecCompactionInvalidationOptions,
  ): Promise<CogSecCompactionInvalidationResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const compactionIds = new Set(options.compactionIds.map((id, index) => (
      normalizeEntryId(id, `compactionIds[${index}]`)
    )));
    if (compactionIds.size === 0) {
      throw new Error('CogSec compaction invalidation requires at least one compaction ID');
    }

    await this.context.bumpSessionTailEpoch(options.channelId, 'cogsec_compaction_invalidation');
    const result = await this.context.withPostRewriteTailFence(
      options.channelId,
      'cogsec_compaction_invalidation',
      (markRewritten) => this.context.withLockedExistingChannelWrite(options.channelId, (cache, renewLease) => {
        const journalChain = readSessionJournalChain(this.context.journalRuntime, cache);
        const rawEntries = journalChain.entries;
        const selectedIds = rawEntries
          .filter(entry => entry.type === 'compaction' && compactionIds.has(entry.id))
          .map(entry => entry.id);
        if (selectedIds.length === 0) {
          return {
            caseId,
            channelId: cache.channelId,
            invalidatedCompactionIds: [],
          } satisfies CogSecCompactionInvalidationResult;
        }

        const invalidatedSummary = buildCogSecInvalidatedSummaryContent(caseId);
        const selectedIdSet = new Set(selectedIds);
        const rewrittenEntriesByArchive = journalChain.entriesByArchive.map(entries => (
          entries.map(entry => (
            entry.type === 'compaction' && selectedIdSet.has(entry.id)
              ? buildCogSecInvalidatedCompactionJournalEntry(entry, invalidatedSummary)
              : entry
          ))
        ));

        this.context.journalRuntime.rewriteJournalEntryChain(
          journalChain.archives,
          rewrittenEntriesByArchive,
          renewLease,
        );
        markRewritten();
        const reloaded = loadSessionJournalChain(this.context.journalRuntime, cache);
        const sessionKey = this.context.resolveCacheSessionKey(cache);
        this.context.setChannelCache(sessionKey, reloaded);
        this.context.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));

        return {
          caseId,
          channelId: cache.channelId,
          invalidatedCompactionIds: selectedIds,
        } satisfies CogSecCompactionInvalidationResult;
      }),
    );

    if (!result) {
      throw new Error(`Session channel not found for CogSec compaction invalidation: ${options.channelId}`);
    }
    return result;
  }

  async applyCogSecCompactionRegenerations(
    options: CogSecCompactionRegenerationOptions,
  ): Promise<CogSecCompactionRegenerationResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const summariesById = new Map<number, string>();
    for (const [index, summary] of options.summaries.entries()) {
      const compactionId = normalizeEntryId(summary.compactionId, `summaries[${index}].compactionId`);
      summariesById.set(
        compactionId,
        normalizeCogSecRegeneratedSummary(summary.summary, `summaries[${index}].summary`),
      );
    }
    if (summariesById.size === 0) {
      throw new Error('CogSec compaction regeneration requires at least one summary');
    }

    await this.context.bumpSessionTailEpoch(options.channelId, 'cogsec_compaction_regeneration');
    const result = await this.context.withPostRewriteTailFence(
      options.channelId,
      'cogsec_compaction_regeneration',
      (markRewritten) => this.context.withLockedExistingChannelWrite(options.channelId, (cache, renewLease) => {
        const journalChain = readSessionJournalChain(this.context.journalRuntime, cache);
        const regeneratedIds: number[] = [];
        const skippedIds: number[] = [];
        const rewrittenEntriesByArchive = journalChain.entriesByArchive.map(entries => (
          entries.map(entry => {
            if (entry.type !== 'compaction' || !summariesById.has(entry.id)) return entry;
            const currentSummary = entry.summary ?? '';
            if (!isCogSecInvalidatedSummaryContent(currentSummary)) {
              skippedIds.push(entry.id);
              return entry;
            }
            regeneratedIds.push(entry.id);
            return buildCogSecInvalidatedCompactionJournalEntry(entry, summariesById.get(entry.id)!);
          })
        ));

        for (const id of summariesById.keys()) {
          if (!regeneratedIds.includes(id) && !skippedIds.includes(id)) {
            skippedIds.push(id);
          }
        }

        if (regeneratedIds.length > 0) {
          this.context.journalRuntime.rewriteJournalEntryChain(
            journalChain.archives,
            rewrittenEntriesByArchive,
            renewLease,
          );
          markRewritten();
          const reloaded = loadSessionJournalChain(this.context.journalRuntime, cache);
          const sessionKey = this.context.resolveCacheSessionKey(cache);
          this.context.setChannelCache(sessionKey, reloaded);
          this.context.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));
        }

        return {
          caseId,
          channelId: cache.channelId,
          regeneratedCompactionIds: regeneratedIds,
          skippedCompactionIds: skippedIds,
        } satisfies CogSecCompactionRegenerationResult;
      }),
    );

    if (!result) {
      throw new Error(`Session channel not found for CogSec compaction regeneration: ${options.channelId}`);
    }
    return result;
  }
}

export function buildCogSecTombstoneDiagnostics(inputs: {
  channelId: string;
  entries: readonly SessionEntry[];
}[]): CogSecTombstoneDiagnostic[] {
  const byCase = new Map<string, Map<string, number[]>>();

  for (const input of inputs) {
    for (const entry of input.entries) {
      const caseId = parseCogSecTombstoneCaseId(entry);
      if (!caseId) continue;
      let channels = byCase.get(caseId);
      if (!channels) {
        channels = new Map<string, number[]>();
        byCase.set(caseId, channels);
      }
      const messageIds = channels.get(input.channelId) ?? [];
      messageIds.push(entry.id);
      channels.set(input.channelId, messageIds);
    }
  }

  return [...byCase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, channelsById]) => {
      const channels = [...channelsById.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([channelId, messageIds]) => ({
          channelId,
          messageIds: [...messageIds].sort((left, right) => left - right),
          rowCount: messageIds.length,
        }));
      return {
        caseId,
        rowCount: channels.reduce((sum, channel) => sum + channel.rowCount, 0),
        channels,
      };
    });
}
