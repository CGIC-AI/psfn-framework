import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SessionEntry } from '../session/types.js';
import type { NearTurnMemoryScopeClassifierPort } from '../../faculties/memory/near-turn-memory-lane.js';
import { detectCompanionNameMatch } from '../../faculties/memory/extraction/group-salience.js';
import {
  autonomyLevelPermitsDirected,
  autonomyLevelPermitsPassiveName,
  createDefaultPassiveNameCandidateSettings,
  type ParticipationAutonomyLevel,
  type PassiveNameCandidateSettings,
} from '../../system/config/participation-config.js';
import type {
  ParticipationCandidate,
  ParticipationCandidateTrigger,
  ParticipationContextMessage,
  PassiveNameCandidateDecision,
} from './types.js';

/**
 * Deterministic passive-name participation candidate gate (free-time social
 * autonomy, bible §8.1). Given an observed room message it either creates one
 * `ParticipationCandidate` or reports a single deterministic suppression reason.
 *
 * Reuse mandate (adjudication S5/R3): this gate does NOT add a second
 * name-detection or group/direct classification path. Companion-name detection
 * reuses `detectCompanionNameMatch` from the group-salience machinery, and
 * group-vs-direct scope reuses the canonical
 * `ObservedGroupMemoryScheduler.classifyChannelMemoryScope` classifier via the
 * `NearTurnMemoryScopeClassifierPort` seam.
 *
 * Out of scope here (see sibling beads): the ~10-minute name-spam debounce
 * window (jp36.3.2.2), the cheap appraiser (jp36.3.3), and the speaking arbiter
 * (jp36.5). This gate only decides whether a candidate exists.
 */

/** Preceding-context source: reuses the session store's `getRecent`. */
export interface ParticipationContextReader {
  getRecent(
    channelId: string,
    limit: number,
  ): SessionEntry[] | Promise<SessionEntry[]>;
}

export interface PassiveNameCandidateBuilderOptions {
  scopeClassifier: NearTurnMemoryScopeClassifierPort;
  contextReader: ParticipationContextReader;
  companionNames: readonly string[];
  companionAuthorIds: readonly string[];
  settings?: PassiveNameCandidateSettings;
  nowMs?: () => number;
}

/** The same-cluster inter-companion lane; ICP owns its own consent moment. */
const ICP_CHANNEL_TYPE = 'companion';

interface ChannelDedupeState {
  order: string[];
  seen: Set<string>;
}

export class PassiveNameCandidateBuilder {
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort;
  private readonly contextReader: ParticipationContextReader;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly settings: PassiveNameCandidateSettings;
  private readonly nowMs: () => number;
  private readonly dedupeByChannel = new Map<string, ChannelDedupeState>();

  constructor(options: PassiveNameCandidateBuilderOptions) {
    this.scopeClassifier = options.scopeClassifier;
    this.contextReader = options.contextReader;
    this.companionNames = options.companionNames;
    this.companionAuthorIds = options.companionAuthorIds;
    this.settings = options.settings ?? createDefaultPassiveNameCandidateSettings();
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async build(message: SubstrateMessage): Promise<PassiveNameCandidateDecision> {
    if (!this.settings.enabled) {
      return this.suppress(message, 'disabled');
    }

    // 1. Never react to the companion's own messages.
    if (this.companionAuthorIds.includes(message.authorId)) {
      return this.suppress(message, 'own_message');
    }

    // 2. ICP inter-companion lane already has its own consent moment (§7 R6.1).
    if (message.channelType === ICP_CHANNEL_TYPE) {
      return this.suppress(message, 'icp_lane');
    }

    // 3. Direct/private messages are never group rooms.
    if (message.isDirectMessage === true) {
      return this.suppress(message, 'direct_message');
    }

    // 4. Group rooms only — reuse the canonical direct-vs-group classifier.
    const scope = await this.scopeClassifier.classifyChannelMemoryScope({
      channelId: message.channelId,
      channelType: message.channelType,
    });
    if (scope !== 'group') {
      return this.suppress(message, 'not_group');
    }

    // 5. Companion-name detection — reuse the group-salience name detector.
    const match = detectCompanionNameMatch(message.content, {
      companionNames: this.companionNames,
      companionAuthorIds: this.companionAuthorIds,
    });
    if (!match.mentioned && !match.directAddress) {
      return this.suppress(message, 'no_name_match');
    }
    const trigger: ParticipationCandidateTrigger = match.directAddress
      ? 'direct_mention'
      : 'passive_name';

    // 6. Autonomy ladder gate (§8.4).
    const level = this.resolveAutonomyLevel(message.channelId);
    const permitted = trigger === 'direct_mention'
      ? autonomyLevelPermitsDirected(level)
      : autonomyLevelPermitsPassiveName(level);
    if (!permitted) {
      return this.suppress(message, 'autonomy_disabled', trigger);
    }

    // 7. Staleness guard — never resurrect long-delayed observed mentions.
    const triggerTimestampMs = message.timestamp.getTime();
    if (
      Number.isFinite(triggerTimestampMs)
      && this.nowMs() - triggerTimestampMs > this.settings.stalenessMs
    ) {
      return this.suppress(message, 'stale', trigger);
    }

    // 8. One candidate per source message (dedup across redeliveries).
    if (this.hasSeen(message.channelId, message.id)) {
      return this.suppress(message, 'duplicate', trigger);
    }
    this.markSeen(message.channelId, message.id);

    const precedingContext = await this.loadPrecedingContext(message, triggerTimestampMs);
    const candidate: ParticipationCandidate = {
      schemaVersion: 1,
      channelId: message.channelId,
      channelType: message.channelType,
      sourceMessageId: message.id,
      trigger,
      triggerAuthorId: message.authorId,
      triggerAuthorName: message.authorName,
      triggerContent: message.content,
      triggerTimestampMs,
      matchedName: match.mentioned,
      matchedDirectAddress: match.directAddress,
      precedingContext,
      createdAtMs: this.nowMs(),
    };
    return { status: 'created', candidate };
  }

  private suppress(
    message: Pick<SubstrateMessage, 'channelId' | 'id'>,
    reason: Extract<PassiveNameCandidateDecision, { status: 'suppressed' }>['reason'],
    trigger?: ParticipationCandidateTrigger,
  ): PassiveNameCandidateDecision {
    return {
      status: 'suppressed',
      reason,
      channelId: message.channelId,
      sourceMessageId: message.id,
      ...(trigger ? { trigger } : {}),
    };
  }

  private resolveAutonomyLevel(channelId: string): ParticipationAutonomyLevel {
    return this.settings.channelAutonomyLevels[channelId]
      ?? this.settings.defaultAutonomyLevel;
  }

  private hasSeen(channelId: string, sourceMessageId: string): boolean {
    return this.dedupeByChannel.get(channelId)?.seen.has(sourceMessageId) ?? false;
  }

  private markSeen(channelId: string, sourceMessageId: string): void {
    let state = this.dedupeByChannel.get(channelId);
    if (!state) {
      state = { order: [], seen: new Set() };
      this.dedupeByChannel.set(channelId, state);
    }
    if (state.seen.has(sourceMessageId)) {
      return;
    }
    state.seen.add(sourceMessageId);
    state.order.push(sourceMessageId);
    const cap = this.settings.dedupeHistoryPerChannel;
    while (state.order.length > cap) {
      const evicted = state.order.shift();
      if (evicted !== undefined) {
        state.seen.delete(evicted);
      }
    }
  }

  private async loadPrecedingContext(
    message: SubstrateMessage,
    triggerTimestampMs: number,
  ): Promise<ParticipationContextMessage[]> {
    const want = this.settings.precedingContextMessages;
    if (want <= 0) {
      return [];
    }
    // Over-read a small buffer so filtering out the source message (if it is
    // already persisted) and any out-of-window entries still leaves `want`.
    const entries = await this.contextReader.getRecent(message.channelId, want + 4);
    const hasTriggerTs = Number.isFinite(triggerTimestampMs);
    const preceding = entries
      .filter((entry) => entry.discordMessageId !== message.id)
      .filter((entry) => !hasTriggerTs || entry.timestamp <= triggerTimestampMs)
      .filter((entry) => entry.content.length > 0)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-want);
    return preceding.map((entry) => ({
      messageId: entry.discordMessageId ?? String(entry.id),
      authorId: entry.authorId ?? '',
      authorName: entry.authorName ?? entry.role,
      content: entry.content,
      timestampMs: entry.timestamp,
    }));
  }
}
