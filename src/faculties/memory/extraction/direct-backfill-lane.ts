// ── Direct-session lane of the operator memory backfill (psfn-framework-d5e0p.17) ──
// The Garden group-memory backfill replays an existing transcript range through
// extraction. Direct conversations (a 1:1 DM, a companion-DM) cannot use the
// group lane: it selects salient spans and routes facts as overheard room
// context. This module holds what differs for the direct lane; the plan,
// bounds, watermark, and per-chunk loop stay in group-backfill.ts.
//
// Fail closed: a session takes the direct lane only when the group classifier
// resolves it as direct (a companion-DM by channel contract, a transcript
// recorded with private visibility, or an explicit direct memory mode). A direct chunk is handed to the normal
// extraction pipeline with the resolved single counterparty; an unresolvable
// counterparty is reported, never guessed.

import type { SessionEntry } from '../../../core/session/types.js';
import { isNonConversationalSessionEntry } from '../../../core/session/manager-primitives.js';
import { parseCompanionChannelId } from '../../../shared/contracts/companion-channels.js';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import type {
  DirectBackfillExtractionOptions,
  DirectBackfillExtractionResult,
} from '../extraction.js';
import {
  resolveSessionMemoryAttribution,
  type SessionCounterpartyContactStore,
} from '../session-counterparty-resolution.js';
import type { GroupMemoryChannelTopology } from './group-classifier.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT, type ExtractionPreLlmGateReason } from './types.js';

/**
 * Direct coverage is tracked under its own watermark key, so a direct replay
 * never moves (or is skipped by) a channel's group-memory watermark.
 */
export const DIRECT_BACKFILL_POLICY_VERSION = 'direct-backfill:v1';

export interface DirectBackfillExtractorPort {
  extractDirectBackfillRange(
    options: DirectBackfillExtractionOptions,
  ): Promise<DirectBackfillExtractionResult>;
}

/** Content-free, count-only view of one direct chunk's extraction run. */
export interface DirectBackfillExtractionView {
  parsedCount: number;
  acceptedCount: number;
  writeCount: number;
  deduplicatedCount: number;
  supersededCount: number;
  /** Gate-passing facts dropped by the per-run write cap (psfn-framework-d5e0p.14). */
  writeCapSkippedCount: number;
  /** Non-zero rejection reasons only. */
  rejectionReasons: Record<string, number>;
  ambiguousSpeakerSkipReasons?: Record<string, number>;
  preLlmGateSkipped?: true;
  preLlmGateReason?: ExtractionPreLlmGateReason;
  memoryIds: string[];
}

/**
 * Topology evidence for the backfill classification. A companion-DM is a
 * direct message by its channel contract. Otherwise, when every entry that
 * recorded a channel visibility recorded `private`, the transcript itself says
 * it is a direct message. Mixed or absent evidence adds nothing, so the
 * classifier falls back to its ordinary channel-type rules.
 */
export function resolveBackfillChannelTopology(
  channelId: string,
  entries: readonly SessionEntry[],
): GroupMemoryChannelTopology | undefined {
  if (parseCompanionChannelId(channelId)?.kind === 'dm') {
    return { kind: 'direct_message', source: 'channel_type' };
  }
  const recorded = entries
    .map(entry => decodeStoredChannelVisibility(entry.channelVisibility))
    .filter(visibility => visibility !== undefined);
  return recorded.length > 0 && recorded.every(visibility => visibility === 'private')
    ? { channelVisibility: 'private' }
    : undefined;
}

/**
 * The entries a direct chunk sends to extraction: its own conversational
 * entries, no group overlap context. A chunk is planned at no more than the
 * extraction recovery window, so the orchestrator never trims its head.
 */
export function selectDirectBackfillEntries(newEntries: readonly SessionEntry[]): SessionEntry[] {
  const entries = newEntries.filter(entry => !isNonConversationalSessionEntry(entry));
  if (entries.length > RECOVERY_CONTEXT_MESSAGE_LIMIT) {
    throw new Error(
      `Direct backfill chunk exceeds the ${RECOVERY_CONTEXT_MESSAGE_LIMIT}-entry extraction window`,
    );
  }
  return entries;
}

export function capDirectBackfillChunkSize(maxMessagesPerChunk: number): number {
  return Math.min(maxMessagesPerChunk, RECOVERY_CONTEXT_MESSAGE_LIMIT);
}

/** The single canonical counterparty a background pass may attribute to. */
export async function resolveDirectBackfillCounterparty(params: {
  channelId: string;
  entries: readonly SessionEntry[];
  contactStore?: SessionCounterpartyContactStore | null;
  localCompanionId?: string;
  companionAuthorIds: readonly string[];
}): Promise<string | undefined> {
  const attribution = await resolveSessionMemoryAttribution({
    sessionId: params.channelId,
    entries: params.entries,
    ...(params.contactStore ? { contactStore: params.contactStore } : {}),
    ...(params.localCompanionId ? { localCompanionId: params.localCompanionId } : {}),
    companionAuthorIds: params.companionAuthorIds,
  });
  return attribution.kind === 'single_contact' ? attribution.contactId : undefined;
}

export function summarizeDirectBackfillExtraction(
  result: DirectBackfillExtractionResult,
): DirectBackfillExtractionView {
  const { telemetry } = result;
  const rejectionReasons = Object.fromEntries(
    Object.entries(telemetry.rejectionBreakdown).filter(([, count]) => count > 0),
  );
  return {
    parsedCount: telemetry.parsedCount,
    acceptedCount: telemetry.acceptedCount,
    writeCount: telemetry.writeCount,
    deduplicatedCount: telemetry.deduplicatedCount,
    supersededCount: telemetry.supersededCount,
    writeCapSkippedCount: telemetry.rejectionBreakdown.write_cap,
    rejectionReasons,
    ...(telemetry.ambiguousSpeakerSkipReasons
      ? { ambiguousSpeakerSkipReasons: { ...telemetry.ambiguousSpeakerSkipReasons } }
      : {}),
    ...(telemetry.preLlmGateSkipped ? { preLlmGateSkipped: true as const } : {}),
    ...(telemetry.preLlmGateReason ? { preLlmGateReason: telemetry.preLlmGateReason } : {}),
    memoryIds: [...result.outputs.memoryIds],
  };
}
