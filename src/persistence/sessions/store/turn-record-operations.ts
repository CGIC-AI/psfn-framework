import { createHash } from 'node:crypto';
import type { SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import { isTurnRecordRecoveryEvidenceError } from '../../../core/agent/background-work/recovery-contract.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { journalToTurnTombstoneEntry } from '../../journals/journal-utils.js';
import { readTurnTombstoneAuthoritySnapshot } from '../turn-tombstone-authority.js';
import {
  slimTurnRecordSessionEntriesForAppend,
  resolveTurnRecordSessionEntries,
  type TurnRecordContinuityWithheld,
  type TurnRecordMessageWithheld,
  type TurnRecordRecentEntryHealDrop,
  type TurnRecordWireBodyWithheld,
} from '../turn-record-session-refs.js';
import { slimTurnRecordMemoryCandidatesForAppend } from '../turn-record-memory-refs.js';
import type {
  TurnRecordPage,
  TurnRecordPageCursor,
  TurnRecordRecoveryScanOptions,
  TurnRecordStorePort,
  TurnRecordUsageRecord,
} from '../turn-record-store-port.js';
import type { TurnRecordEligibilityFencePort } from '../turn-record-eligibility-fence-port.js';
import {
  selectEligibleTurnRecordSnapshotEntries,
  sessionEntrySnapshotMatches,
  TurnRecordEligibilitySnapshotChangedError,
  TurnRecordEligibilitySnapshotInvalidError,
  type SourceTurnRecordEligibility,
} from '../turn-record-eligibility-snapshot.js';

import {
  normalizeOptionalNonNegativeNumber,
  type ChannelCache,
  type ChannelIndexEntry,
} from '../store-primitives.js';
import type { ResolvedIndexedSession } from './channel-index.js';
import type { SessionJournalRuntime } from './journal-runtime.js';
import { syncLightweightSessionCacheFromIndex } from './session-chain-cache.js';

const log = createComponentLogger('SessionStore');

/**
 * Process-lifetime count of turn-record `recentEntries` heal-drops (an id-backed
 * entry that was dropped on read because its L0 row is gone). Emitted as a stable
 * structured event with a running counter — mirroring the turn-record quarantine
 * telemetry in turn-records.ts, since no telemetry port is reachable from the
 * persistence layer. Lets operators distinguish legitimate redaction/rolloff
 * drops (this signal, expected) from structural ref corruption (fails closed
 * upstream and throws, never reaching here). See bead psfn-framework-hgw3.10.
 */
let recentEntryHealDropCount = 0;
function emitRecentEntryHealDrop(drop: TurnRecordRecentEntryHealDrop): void {
  recentEntryHealDropCount += 1;
  log.info('turn_record_recent_entry_heal_drop', {
    ...drop,
    healDropsThisProcess: recentEntryHealDropCount,
  });
}

/**
 * Process-lifetime count of captured wire bodies withheld on read because a
 * source L0 entry they embedded was redacted/removed (bead psfn-framework-eb14).
 * Emitted as a stable structured event with a running counter, mirroring the
 * recentEntries heal-drop telemetry above — no telemetry port is reachable from
 * the persistence layer. Lets operators see redaction propagating into the
 * observability wire surface.
 */
let wireBodyWithheldCount = 0;
function emitWireBodyWithheld(event: TurnRecordWireBodyWithheld): void {
  wireBodyWithheldCount += 1;
  log.info('turn_record_wire_body_withheld', {
    ...event,
    wireBodiesWithheldThisProcess: wireBodyWithheldCount,
  });
}

let turnMessageWithheldCount = 0;
function emitTurnMessageWithheld(event: TurnRecordMessageWithheld): void {
  turnMessageWithheldCount += 1;
  log.info('turn_record_message_withheld', {
    ...event,
    messagesWithheldThisProcess: turnMessageWithheldCount,
  });
}

let continuityWithheldCount = 0;
function emitContinuityWithheld(event: TurnRecordContinuityWithheld): void {
  continuityWithheldCount += 1;
  log.info('turn_record_continuity_withheld', {
    ...event,
    continuityEntriesWithheldThisProcess: continuityWithheldCount,
  });
}

/** Initial overscan multiplier for tombstone-filtered turn-record reads. */
const TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR = 4;
/** Hard bound preventing a post-turn effect from turning one session into an unbounded lock set. */
const MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES = 512;

const RECOVERY_AUTHORITY_LIMITS = Object.freeze({
  cacheOwners: 8,
  maxActionBytes: 256 * 1024,
  maxActions: 4_096,
  maxResultBytes: 2 * 1024 * 1024,
  maxRowBytes: 32 * 1024 * 1024,
  maxTombstones: 4_096,
  scanChunkBytes: 64 * 1024,
});

export interface SessionTurnRecordOperationsContext {
  readonly sessionsDir: string;
  readonly journalRuntime: SessionJournalRuntime;
  readonly turnRecordStore: TurnRecordStorePort;
  readonly turnRecordEligibilityFence: TurnRecordEligibilityFencePort | null;
  readonly recoveryAuthoritySnapshotHook:
    | ((ownerSessionId: string) => void | Promise<void>)
    | undefined;
  resolveSessionId(channelId: string): string | null;
  resolveExistingSession(channelId: string): ResolvedIndexedSession | null;
  getChannelIndexEntry(sessionId: string): ChannelIndexEntry | undefined;
  ensureChannelIndexEntry(
    sessionId: string,
    channelId: string,
    filePaths: readonly string[],
  ): ChannelIndexEntry;
  getLoadedCache(channelId: string): ChannelCache | undefined;
  loadExistingChannelCache(channelId: string): ChannelCache | null;
  ensureChannelFullyLoaded(channelId: string): ChannelCache | null;
  resolveJournalAuthoritativeTurnTombstones(params: {
    sessionId: string;
    channelId: string;
    filePaths: readonly string[];
    cache?: ChannelCache;
  }): ReadonlySet<string>;
  syncTranscriptProjectionForChannel(
    channelId: string,
    entries: readonly SessionEntry[],
    options?: { redaction?: boolean },
  ): void;
  upsertChannelIndex(sessionId: string, entry: ChannelIndexEntry): void;
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[];
  refreshChannelIndexFromDisk(): void;
}

export class SessionTurnRecordOperations {
  private readonly recoveryTombstoneAuthority = new Map<string, {
    archiveFingerprint: string;
    baselineFingerprint: string;
    tombstones: Set<string>;
  }>();

  constructor(private readonly context: SessionTurnRecordOperationsContext) {}

  async appendTurnRecord(record: TurnRecord): Promise<void> {
    await this.withTurnRecordEligibilityMutationFence(
      record.sessionId ?? record.channelId,
      record.turnId,
      async () => {
        this.context.turnRecordStore.appendTurnRecord(
          slimTurnRecordMemoryCandidatesForAppend(
            slimTurnRecordSessionEntriesForAppend(record),
          ),
        );
      },
    );
  }

  async withSourceTurnRecordEligibilityFence<T>(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!sourceChannelId.trim()) {
      throw new Error('TurnRecord eligibility fence sourceChannelId cannot be empty');
    }
    if (!this.context.turnRecordEligibilityFence) {
      throw new Error('TurnRecord eligibility fence is not configured');
    }
    return this.context.turnRecordEligibilityFence.withTurnRecordEligibilityFence({
      logicalSessionId,
      turnId,
    }, operation, { signal });
  }

  /**
   * Captures a bounded content window, locks every TurnID represented in that
   * window plus the required source IDs, then re-reads and validates the exact
   * snapshot before exposing it to a durable effect.
   */
  async withStableTurnRecordEligibilitySnapshot<T>(
    logicalSessionId: string,
    requiredTurnIds: readonly string[],
    readSnapshot: () => SessionEntry[],
    operation: (entries: readonly SessionEntry[]) => Promise<T>,
  ): Promise<T> {
    const normalizedSessionId = logicalSessionId.trim();
    if (!normalizedSessionId) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility snapshot logicalSessionId cannot be empty',
      );
    }
    if (!this.context.turnRecordEligibilityFence) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility fence is not configured',
      );
    }

    const initial = readSnapshot();
    const consumed = initial.map((entry) => ({
      sourceChannelId: entry.originChannelId?.trim() || entry.channelId,
      turnId: resolveSessionEntryTurnContext(entry).turnId,
    }));
    const turnIds = new Set<string>();
    for (const turnId of requiredTurnIds) {
      const normalized = turnId.trim();
      if (!normalized) {
        throw new TurnRecordEligibilitySnapshotInvalidError(
          'TurnRecord eligibility snapshot required TurnID cannot be empty',
        );
      }
      turnIds.add(normalized);
    }
    for (const reference of consumed) turnIds.add(reference.turnId);
    if (turnIds.size === 0) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility snapshot must contain at least one TurnID',
      );
    }
    if (turnIds.size > MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        `TurnRecord eligibility snapshot exceeds ${MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES} TurnIDs`,
      );
    }

    return this.context.turnRecordEligibilityFence.withTurnRecordEligibilityFences(
      [...turnIds].map(turnId => ({ logicalSessionId: normalizedSessionId, turnId })),
      async () => {
        const current = readSnapshot();
        if (!sessionEntrySnapshotMatches(initial, current)) {
          throw new TurnRecordEligibilitySnapshotChangedError();
        }

        const eligibleEntries = await selectEligibleTurnRecordSnapshotEntries({
          entries: current,
          logicalSessionId: normalizedSessionId,
          lookupEligibility: (sourceChannelId, logicalOwnerSessionId, turnId) => (
            this.lookupSourceTurnRecordEligibility(
              sourceChannelId,
              logicalOwnerSessionId,
              turnId,
            )
          ),
        });
        return operation(eligibleEntries);
      },
    );
  }

  async withTurnRecordEligibilityMutationFence<T>(
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.context.turnRecordEligibilityFence) return operation();
    return this.context.turnRecordEligibilityFence.withTurnRecordEligibilityFence({
      logicalSessionId,
      turnId,
    }, operation);
  }

  /**
   * Reconstruct L0-referenced session entries and redaction-gate the rendered
   * view (bead psfn-framework-9ree) at the persistence read boundary, so every
   * consumer above the store sees fully inline, journal-current records. Pre-9ree
   * "old fat" records (inline recentEntries, no ref) are redaction-gated against
   * L0 here too (bead psfn-framework-hgw3.10); id-backed heal-drops emit
   * structured telemetry via emitRecentEntryHealDrop. The captured provider wire
   * body is withheld here if a source L0 entry it embedded was redacted/removed
   * (bead psfn-framework-eb14), emitting telemetry via emitWireBodyWithheld.
   */
  private resolveTurnRecordSessionRefs(record: TurnRecord): TurnRecord {
    return resolveTurnRecordSessionEntries(
      record,
      (channelId, minId, maxId) => this.context.getEntriesInRange(channelId, minId, maxId),
      emitRecentEntryHealDrop,
      emitWireBodyWithheld,
      emitTurnMessageWithheld,
      emitContinuityWithheld,
    );
  }

  findTurnRecord(channelId: string, turnId: string): TurnRecord | null {
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const record = this.context.turnRecordStore.findTurnRecord(sessionId, turnId);
    return record ? this.resolveTurnRecordSessionRefs(record) : null;
  }

  /**
   * Find one canonical turn by its physical source channel while proving that
   * it belongs to the expected logical session. Background work uses this
   * exact scope so a later route reset cannot redirect an old durable job to a
   * newer logical session on the same transport channel.
   */
  findSourceTurnRecord(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
  ): TurnRecord | null {
    const record = this.context.turnRecordStore.findTurnRecord(sourceChannelId, turnId);
    if (!record || record.channelId !== sourceChannelId) return null;
    return (record.sessionId ?? sourceChannelId) === logicalSessionId
      ? this.resolveTurnRecordSessionRefs(record)
      : null;
  }

  /**
   * Resolves the sole eligible durable owner for an exact physical source and
   * turn. Recovery callers do not yet know the logical owner, so this lookup
   * derives it from the canonical record while preserving the same duplicate
   * and tombstone fences used by background work. Null means no record exists;
   * an existing ambiguous or ineligible source fails closed.
   */
  private async lookupSourceTurnRecordIdentity(
    sourceChannelId: string,
    turnId: string,
    signal?: AbortSignal,
  ) {
    const normalizedSourceChannelId = sourceChannelId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedSourceChannelId || !normalizedTurnId) {
      throw new Error('Source TurnRecord lookup requires a physical channel and turn id');
    }
    const lookup = this.context.turnRecordStore.lookupTurnRecordIdentity;
    if (!lookup) {
      throw new Error('TurnRecord store does not support snapshot-consistent exact identity lookup');
    }
    return await lookup.call(
      this.context.turnRecordStore,
      normalizedSourceChannelId,
      normalizedTurnId,
      { signal },
    );
  }

  private resolveEligibleSourceTurnRecord(
    sourceChannelId: string,
    ownerSessionId: string | null,
    turnId: string,
    record: TurnRecord,
  ): TurnRecord | null {
    const normalizedSourceChannelId = sourceChannelId.trim();
    const normalizedTurnId = turnId.trim();
    const declaredOwnerSessionId = record.sessionId ?? normalizedSourceChannelId;
    if (record.channelId !== normalizedSourceChannelId
      || (ownerSessionId !== null && declaredOwnerSessionId !== ownerSessionId.trim())) {
      return null;
    }
    const owner = this.context.ensureChannelFullyLoaded(declaredOwnerSessionId);
    if (owner === null || owner.turnTombstones.has(normalizedTurnId)) return null;
    return this.resolveTurnRecordSessionRefs(record);
  }

  async findUniqueSourceTurnRecord(
    sourceChannelId: string,
    turnId: string,
  ): Promise<TurnRecord | null> {
    const lookup = await this.lookupSourceTurnRecordIdentity(sourceChannelId, turnId);
    if (lookup.kind === 'missing') return null;
    if (lookup.kind === 'duplicated') {
      throw new Error('Source TurnRecord is duplicated and cannot establish a recovery identity');
    }
    const eligible = this.resolveEligibleSourceTurnRecord(
      sourceChannelId,
      null,
      turnId,
      lookup.record,
    );
    if (!eligible) {
      throw new Error('Source TurnRecord is tombstoned, missing its owner, or belongs to another source');
    }
    return eligible;
  }

  async findEligibleSourceTurnRecord(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<TurnRecord | null> {
    const eligibility = await this.lookupSourceTurnRecordEligibility(
      sourceChannelId,
      ownerSessionId,
      turnId,
      signal,
    );
    return eligibility.kind === 'eligible' ? eligibility.record : null;
  }

  async lookupSourceTurnRecordEligibility(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<SourceTurnRecordEligibility> {
    if (!ownerSessionId.trim()) {
      throw new Error('Source TurnRecord eligibility requires an owner session id');
    }
    const lookup = await this.lookupSourceTurnRecordIdentity(sourceChannelId, turnId, signal);
    signal?.throwIfAborted();
    if (lookup.kind === 'missing') return { kind: 'missing' };
    if (lookup.kind === 'duplicated') return { kind: 'ineligible' };
    const record = this.resolveEligibleSourceTurnRecord(
      sourceChannelId,
      ownerSessionId,
      turnId,
      lookup.record,
    );
    return record
      ? { kind: 'eligible', record }
      : { kind: 'ineligible' };
  }

  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    if (limit <= 0) return [];
    this.context.refreshChannelIndexFromDisk();
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(channelId)
      ?? this.context.loadExistingChannelCache(channelId);
    const resolved = this.context.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) {
      return this.context.turnRecordStore.readRecentTurnRecords(sessionId, limit)
        .map(record => this.resolveTurnRecordSessionRefs(record));
    }
    const indexEntry = this.context.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached) {
      syncLightweightSessionCacheFromIndex({
        cache: cached,
        indexEntry,
        sessionsDir: this.context.sessionsDir,
      });
    }
    const tombstones = this.context.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    if (tombstones.size === 0) {
      return this.context.turnRecordStore.readRecentTurnRecords(sessionId, limit)
        .map(record => this.resolveTurnRecordSessionRefs(record));
    }
    return this.readTombstoneFilteredTurnRecords(sessionId, limit, tombstones)
      .map(record => this.resolveTurnRecordSessionRefs(record));
  }

  /**
   * Content-free deterministic-analytics read. Unlike getRecentTurnRecords,
   * this path never reconstructs session context or captured provider bodies,
   * so a metadata-only background task cannot resurrect, retain, or repeatedly
   * heal historical conversation content.
   */
  getRecentTurnRecordUsage(channelId: string, limit: number): TurnRecordUsageRecord[] {
    if (limit <= 0) return [];
    const readUsage = this.context.turnRecordStore.readRecentTurnRecordUsage;
    if (!readUsage) {
      throw new Error('TurnRecord store does not support the content-free usage projection');
    }
    this.context.refreshChannelIndexFromDisk();
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(channelId)
      ?? this.context.loadExistingChannelCache(channelId);
    const resolved = this.context.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) {
      return readUsage.call(this.context.turnRecordStore, sessionId, limit);
    }
    const indexEntry = this.context.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached) {
      syncLightweightSessionCacheFromIndex({
        cache: cached,
        indexEntry,
        sessionsDir: this.context.sessionsDir,
      });
    }
    const tombstones = this.context.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    if (tombstones.size === 0) {
      return readUsage.call(this.context.turnRecordStore, sessionId, limit);
    }
    return this.readTombstoneFilteredTurnRecordUsage(
      sessionId,
      limit,
      tombstones,
      readUsage,
    );
  }

  /**
   * Bounded iterative overscan for tombstone-filtered turn-record reads:
   * request a small multiple of the limit, filter tombstoned turns, and only
   * widen (doubling) while the segment files still have older records to
   * offer. Exactness wins when an unusually dense tombstone window requires
   * reading farther back: returning a partial logical window would violate
   * the public limit contract.
   */
  private readTombstoneFilteredTurnRecords(
    sessionId: string,
    limit: number,
    tombstones: ReadonlySet<string>,
  ): TurnRecord[] {
    let requested = Math.max(limit, limit * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR);
    for (;;) {
      const records = this.context.turnRecordStore.readRecentTurnRecords(sessionId, requested);
      const filtered = records.filter(record => !tombstones.has(record.turnId));
      // Fewer records than requested means the whole archive is already read.
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= limit || exhaustedHistory) {
        return filtered.length > limit ? filtered.slice(-limit) : filtered;
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }

  private readTombstoneFilteredTurnRecordUsage(
    sessionId: string,
    limit: number,
    tombstones: ReadonlySet<string>,
    readUsage: NonNullable<TurnRecordStorePort['readRecentTurnRecordUsage']>,
  ): TurnRecordUsageRecord[] {
    let requested = Math.max(limit, limit * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR);
    for (;;) {
      const records = readUsage.call(this.context.turnRecordStore, sessionId, requested);
      const filtered = records.filter(record => !tombstones.has(record.turnId));
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= limit || exhaustedHistory) {
        return filtered.length > limit ? filtered.slice(-limit) : filtered;
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }

  /**
   * Reads the physical turn-record stream for an exact source channel without
   * resolving it through a logical-session alias. Introspection consent is
   * channel-exact, so routed sessions must use this path instead of widening a
   * source-channel decision to the whole logical session.
   */
  getRecentSourceTurnRecords(sourceChannelId: string, limit: number): TurnRecord[] {
    if (limit <= 0) return [];
    const target = limit;
    let requested = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(target, target * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR),
    );
    for (;;) {
      const records = this.context.turnRecordStore.readRecentTurnRecords(
        sourceChannelId,
        requested,
      );
      const filtered = records.filter((record) => {
        const ownerSessionId = record.sessionId ?? sourceChannelId;
        const owner = this.context.ensureChannelFullyLoaded(ownerSessionId);
        if (!owner) return false;
        return !owner.turnTombstones.has(record.turnId);
      });
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= target || exhaustedHistory) {
        return filtered.slice(-limit)
          .map(record => this.resolveTurnRecordSessionRefs(record));
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }

  private async isRecoveryTurnEligible(
    ownerSessionId: string,
    turnId: string,
    options: TurnRecordRecoveryScanOptions,
  ): Promise<boolean> {
    const limits = RECOVERY_AUTHORITY_LIMITS;
    const resolveEvidence = (): {
      archiveFingerprint: string;
      archives: ReturnType<SessionJournalRuntime['openArchive']>[];
      baselineFingerprint: string;
      baselineTombstones: Set<string>;
      channelId: string;
      filePaths: string[];
      sessionId: string;
    } | null => {
      this.context.refreshChannelIndexFromDisk();
      const resolved = this.context.resolveExistingSession(ownerSessionId);
      if (!resolved) return null;
      const indexed = this.context.getChannelIndexEntry(resolved.sessionId);
      const indexedCount = normalizeOptionalNonNegativeNumber(
        indexed?.activeTurnTombstoneCount,
      ) ?? 0;
      const baselineTombstones = new Set(indexed?.activeTurnTombstoneIds ?? []);
      if (baselineTombstones.size !== indexedCount) {
        throw this.recoveryAuthorityError(
          `Unsigned L0 index tombstone evidence is inconsistent for ${ownerSessionId}`,
        );
      }
      if (baselineTombstones.size > limits.maxTombstones) {
        throw this.recoveryAuthorityError(
          `L0 tombstone authority for ${ownerSessionId} exceeds `
          + `${limits.maxTombstones} retained ids`,
          'EOVERFLOW',
        );
      }
      const archives = resolved.filePaths.map(filePath => (
        this.context.journalRuntime.openArchive(resolved.channelId, filePath)
      ));
      const archiveFingerprint = this.context.journalRuntime.fingerprintArchiveChain(archives);
      if (!archiveFingerprint) return null;
      const baselineFingerprint = createHash('sha256')
        .update([...baselineTombstones].sort().join('\0'))
        .digest('hex');
      return {
        archiveFingerprint,
        archives,
        baselineFingerprint,
        baselineTombstones,
        channelId: resolved.channelId,
        filePaths: [...resolved.filePaths],
        sessionId: resolved.sessionId,
      };
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      options.signal?.throwIfAborted();
      const before = resolveEvidence();
      if (!before) return false;
      const cached = this.recoveryTombstoneAuthority.get(before.sessionId);
      if (
        cached?.archiveFingerprint === before.archiveFingerprint
        && cached.baselineFingerprint === before.baselineFingerprint
      ) {
        this.recoveryTombstoneAuthority.delete(before.sessionId);
        this.recoveryTombstoneAuthority.set(before.sessionId, cached);
        return !cached.tombstones.has(turnId);
      }

      let snapshot;
      try {
        snapshot = await readTurnTombstoneAuthoritySnapshot({
          channelId: before.channelId,
          filePaths: before.filePaths,
          maxActionBytes: limits.maxActionBytes,
          maxActions: limits.maxActions,
          maxResultBytes: limits.maxResultBytes,
          maxRowBytes: limits.maxRowBytes,
          onSnapshot: async () => {
            await this.context.recoveryAuthoritySnapshotHook?.(ownerSessionId);
          },
          scanChunkBytes: limits.scanChunkBytes,
          signal: options.signal,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESTALE' && attempt === 0) continue;
        throw error;
      }
      const after = resolveEvidence();
      if (
        !after
        || after.sessionId !== before.sessionId
        || after.archiveFingerprint !== before.archiveFingerprint
        || after.baselineFingerprint !== before.baselineFingerprint
      ) {
        if (attempt === 0) continue;
        throw this.recoveryAuthorityError(
          `L0 tombstone authority for ${ownerSessionId} changed repeatedly during recovery`,
          'ESTALE',
        );
      }

      const tombstones = new Set(before.baselineTombstones);
      for (const action of snapshot.actions) {
        const normalized = this.context.journalRuntime.verifyAndNormalizeEntry(
          action.entry,
          [action.previousHmac],
        );
        const tombstone = journalToTurnTombstoneEntry(normalized.entry);
        if (!tombstone) {
          throw this.recoveryAuthorityError(
            `L0 authority action for ${ownerSessionId} is not a valid turn tombstone`,
            'EBADMSG',
          );
        }
        if (tombstone.action === 'redact' || !normalized.verified) {
          tombstones.add(tombstone.targetId);
        } else {
          tombstones.delete(tombstone.targetId);
        }
        if (tombstones.size > limits.maxTombstones) {
          throw this.recoveryAuthorityError(
            `L0 tombstone authority for ${ownerSessionId} exceeds `
            + `${limits.maxTombstones} retained ids`,
            'EOVERFLOW',
          );
        }
      }

      this.recoveryTombstoneAuthority.delete(before.sessionId);
      this.recoveryTombstoneAuthority.set(before.sessionId, {
        archiveFingerprint: before.archiveFingerprint,
        baselineFingerprint: before.baselineFingerprint,
        tombstones,
      });
      while (this.recoveryTombstoneAuthority.size > limits.cacheOwners) {
        const oldest = this.recoveryTombstoneAuthority.keys().next().value as string | undefined;
        if (!oldest) break;
        this.recoveryTombstoneAuthority.delete(oldest);
      }
      const stats = options.stats;
      if (stats) {
        stats.authorityActionsReturned = (stats.authorityActionsReturned ?? 0)
          + snapshot.stats.actionsReturned;
        stats.authorityBytesRead = (stats.authorityBytesRead ?? 0) + snapshot.stats.bytesRead;
        stats.authorityFilesScanned = (stats.authorityFilesScanned ?? 0)
          + snapshot.stats.filesScanned;
        stats.authorityMainMessageBytesRetained = 0;
        stats.authorityOwnersScanned = (stats.authorityOwnersScanned ?? 0) + 1;
        stats.authorityPeakOpenFilesOffPrimary = Math.max(
          stats.authorityPeakOpenFilesOffPrimary ?? 0,
          snapshot.stats.peakOpenFiles,
        );
        stats.authorityPeakCachedOwners = Math.max(
          stats.authorityPeakCachedOwners ?? 0,
          this.recoveryTombstoneAuthority.size,
        );
        stats.authorityPeakCachedTombstones = Math.max(
          stats.authorityPeakCachedTombstones ?? 0,
          ...[...this.recoveryTombstoneAuthority.values()].map(value => value.tombstones.size),
        );
        stats.authorityPeakResultBytes = Math.max(
          stats.authorityPeakResultBytes ?? 0,
          snapshot.stats.actionBytesReturned,
        );
        stats.authorityPeakRowBytesOffPrimary = Math.max(
          stats.authorityPeakRowBytesOffPrimary ?? 0,
          snapshot.stats.peakRowBytes,
        );
        stats.authorityRowsScanned = (stats.authorityRowsScanned ?? 0)
          + snapshot.stats.rowsScanned;
      }
      return !tombstones.has(turnId);
    }
    return false;
  }

  private recoveryAuthorityError(message: string, code?: string): Error {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.name = 'TurnRecordRecoveryEvidenceError';
    if (code) error.code = code;
    return error;
  }

  /**
   * Bounded physical paging for introspection/metacognition.
   *
   * Tombstoned or missing-owner rows consume their physical page slot instead
   * of triggering overscan. `exhausted` and `nextCursor` therefore describe
   * the complete fixed persistence snapshot, even when every returned record
   * is filtered out. Shared refs and L0 session refs resolve only for the
   * retained rows in this one page.
   */
  async readSourceTurnRecordPage(
    sourceChannelId: string,
    limit: number,
    cursor?: TurnRecordPageCursor,
  ): Promise<TurnRecordPage> {
    const readPage = this.context.turnRecordStore.readTurnRecordPage;
    if (!readPage) {
      throw new Error('TurnRecord store does not support bounded cursor paging');
    }
    const page = await readPage.call(this.context.turnRecordStore, sourceChannelId, limit, cursor);
    const records = page.records
      .filter((record) => {
        if (record.channelId !== sourceChannelId) return false;
        const ownerSessionId = record.sessionId ?? sourceChannelId;
        const owner = this.context.ensureChannelFullyLoaded(ownerSessionId);
        return owner !== null && !owner.turnTombstones.has(record.turnId);
      })
      .map(record => this.resolveTurnRecordSessionRefs(record));
    return {
      records,
      exhausted: page.exhausted,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * One process-lifetime historical handoff snapshot. The filesystem adapter
   * proves physical uniqueness and global order in one disk-backed pass, so no
   * per-identity state or old-fat archive is retained on the main thread.
   *
   * Owner/tombstone state is re-read from the authoritative L0 journal before a
   * candidate is returned. No history is truncated or accepted on partial
   * evidence.
   */
  async *streamRecoverableBackgroundWorkTurnRecords(
    sourceChannelIds: readonly string[],
    options: TurnRecordRecoveryScanOptions = {},
  ): AsyncGenerator<TurnRecord> {
    const streamSource = this.context.turnRecordStore.streamTurnRecordsForRecovery;
    if (!streamSource) {
      throw new Error('TurnRecord store does not support bounded background-work recovery scans');
    }
    const uniqueSourceSet = new Set(sourceChannelIds);
    const uniqueSources = [...uniqueSourceSet];
    const evidenceBlockedOwners = new Set<string>();
    for await (const record of streamSource.call(this.context.turnRecordStore, uniqueSources, options)) {
      const sourceChannelId = record.channelId;
      if (!uniqueSourceSet.has(sourceChannelId)) continue;
      const logicalSessionId = record.sessionId ?? sourceChannelId;
      if (evidenceBlockedOwners.has(logicalSessionId)) continue;
      try {
        if (!await this.isRecoveryTurnEligible(logicalSessionId, record.turnId, options)) continue;
      } catch (error) {
        if (!isTurnRecordRecoveryEvidenceError(error)) throw error;
        evidenceBlockedOwners.add(logicalSessionId);
        const rawCode = (error as NodeJS.ErrnoException).code;
        const errno = typeof rawCode === 'string' && rawCode ? rawCode : 'UNKNOWN';
        log.warn(
          `Skipping background-work handoff recovery owner ${logicalSessionId} (${errno})`,
          { errno, ownerSessionId: logicalSessionId },
        );
        options.onEvidenceOwnerSkipped?.({ errno, ownerSessionId: logicalSessionId });
        continue;
      }
      yield record;
    }
  }

  async isSourceTurnRecordEligible(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
  ): Promise<boolean> {
    return await this.findEligibleSourceTurnRecord(
      sourceChannelId,
      ownerSessionId,
      turnId,
    ) !== null;
  }
}

export {
  TurnRecordEligibilitySnapshotChangedError,
  TurnRecordEligibilitySnapshotInvalidError,
};
export type { SourceTurnRecordEligibility };
