// ── Blind Reviewer evidence source: pull-only over durable TurnRecords (yxz0z.3) ──
//
// This adapter is the ONLY place the Blind Reviewer touches conversation state,
// and it touches it exactly the way a passive observer must: by reading rows
// that are already durable, after the turn that produced them has completed.
// Nothing here is called from a turn, a tool, or a gateway path, so the user /
// tool hot path cannot wait on the reviewer and cannot fail because of it.
//
// Two fail-closed reductions run at capture, before anything is stored:
//
//   1. Activity signals are counts and tool NAMES only — never arguments,
//      results, or rationale text.
//   2. A text excerpt is admitted only for turns the companion herself already
//      marked verbatim-public and non-intimate (the same `auditPrivacy` gate
//      `faculties/introspection/source.ts` applies), and even then it is put
//      through `blindPublicStimulus` and truncated. Every other turn yields a
//      `structural_only` row with an empty excerpt. The excerpt is the
//      assistant's PUBLIC reply only: tool-call `rationale` is internal
//      reasoning that was never part of the exchange the companion classified,
//      so admitting it would widen a consent envelope she did not open.
//
// The reviewer therefore never sees private content, and the durable window
// never stores any.

import { blindPublicStimulus } from '../../../faculties/introspection/blinding.js';
import {
  blindReviewContentDigest,
  blindReviewEvidenceId,
  blindReviewSourceRef,
  type BlindReviewActivitySignals,
  type BlindReviewDisclosure,
  type BlindReviewEvidenceItem,
  type BlindReviewEvidenceSourcePort,
} from './contracts.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';

/** The narrow read surface this adapter needs from the live session runtime. */
interface BlindReviewTurnRecordReader {
  listRecentSessions(limit: number): Array<{ sessionId: string; sourceChannelId: string }>;
  getRecentSourceTurnRecords(sourceChannelId: string, limit: number): TurnRecord[];
  isSessionRetiredOrQuarantined(sessionId: string): boolean;
}

export interface BlindReviewEvidenceSourceOptions {
  reader: BlindReviewTurnRecordReader;
  recentSessionLimit: number;
  /** Tool identifiers retained per row; owner-file governed, never a literal. */
  maxToolNamesPerItem: number;
}

/**
 * Whether the companion's own recorded classification permits a text excerpt.
 *
 * Every clause must hold. The actor check matters as much as the labels: a
 * sensitivity mark is only companion-drawn when the record says the companion
 * drew it for THIS turn and request, so a transport-populated or mismatched
 * mark yields `structural_only` rather than disclosure.
 */
function permitsBlindedExcerpt(record: TurnRecord): boolean {
  const privacy = record.auditPrivacy;
  if (!privacy) return false;
  if (privacy.contentMode !== 'verbatim_public') return false;
  if (privacy.channelPrivacy !== 'public') return false;
  if (privacy.contentSensitivity !== 'non_intimate') return false;
  if (privacy.reason !== 'explicit_public_non_dm') return false;
  // The contract admits only a companion actor, so the remaining question is
  // whether that mark was drawn for THIS turn and request: a mismatched or
  // absent actor yields `structural_only` rather than disclosure.
  const actor = privacy.contentSensitivityActor;
  if (!actor) return false;
  return actor.turnId === record.turnId && actor.requestId === record.requestId;
}

function toActivitySignals(record: TurnRecord, maxToolNames: number): BlindReviewActivitySignals {
  const toolNames = [...new Set(record.toolCalls.map(call => call.toolName))]
    .sort()
    .slice(0, maxToolNames);
  const durationMs = record.completedAt > record.startedAt
    ? record.completedAt - record.startedAt
    : 0;
  return {
    toolCallCount: record.toolCalls.length,
    toolNames,
    toolErrorCount: record.toolCalls.filter(call => call.isError === true).length,
    assistantChars: record.assistantMessage?.content.length ?? 0,
    userChars: record.userMessage.content.length,
    extractedMemoryCount: record.extractedMemoryIds.length,
    durationMs,
  };
}

/** Blind, then truncate. The companion's public reply only. */
function toBlindedExcerpt(record: TurnRecord, maxChars: number): string {
  const assistant = record.assistantMessage?.content.trim();
  if (!assistant) return '';
  return blindPublicStimulus(assistant).slice(0, maxChars);
}

function toEvidenceItem(
  record: TurnRecord,
  bounds: { maxBlindedCharsPerItem: number; maxToolNamesPerItem: number },
): BlindReviewEvidenceItem {
  const activity = toActivitySignals(record, bounds.maxToolNamesPerItem);
  const blindedExcerpt = permitsBlindedExcerpt(record)
    ? toBlindedExcerpt(record, bounds.maxBlindedCharsPerItem)
    : '';
  const disclosure: BlindReviewDisclosure = blindedExcerpt.length > 0
    ? 'blinded_excerpt'
    : 'structural_only';
  const sourceRef = blindReviewSourceRef(record.channelId, record.turnId);
  return {
    evidenceId: blindReviewEvidenceId(sourceRef),
    sourceRef,
    occurredAtMs: record.completedAt,
    disclosure,
    activity,
    blindedExcerpt,
    contentDigest: blindReviewContentDigest({ disclosure, activity, blindedExcerpt }),
  };
}

/**
 * Poll-side evidence over recent sessions.
 *
 * `sinceMs` is an exclusive watermark on `completedAt`, so a run never re-reads
 * what it already ingested; re-reading anyway would be harmless because
 * evidence identity is a digest of the source ref, but the watermark keeps the
 * scan bounded. Retired and quarantined sessions are skipped outright: their
 * rows are exactly the material an observer must not resurrect.
 */
export function createTurnRecordBlindReviewEvidenceSource(
  options: BlindReviewEvidenceSourceOptions,
): BlindReviewEvidenceSourcePort {
  const { reader, recentSessionLimit, maxToolNamesPerItem } = options;
  return {
    async listEvidence(input): Promise<BlindReviewEvidenceItem[]> {
      if (input.limit <= 0) return [];
      const sessions = reader.listRecentSessions(recentSessionLimit);
      const seen = new Set<string>();
      const items: BlindReviewEvidenceItem[] = [];
      for (const session of sessions) {
        if (reader.isSessionRetiredOrQuarantined(session.sessionId)) continue;
        if (seen.has(session.sourceChannelId)) continue;
        seen.add(session.sourceChannelId);
        const records = reader.getRecentSourceTurnRecords(session.sourceChannelId, input.limit);
        for (const record of records) {
          if (record.status !== 'completed') continue;
          if (record.completedAt <= input.sinceMs) continue;
          items.push(toEvidenceItem(record, {
            maxBlindedCharsPerItem: input.maxBlindedCharsPerItem,
            maxToolNamesPerItem,
          }));
        }
      }
      // Oldest-first so the durable window, the review batch, and the watermark
      // all advance in one direction and a partial run resumes cleanly.
      items.sort((left, right) => (
        left.occurredAtMs - right.occurredAtMs
        || left.evidenceId.localeCompare(right.evidenceId)
      ));
      return items.slice(0, input.limit);
    },
  };
}
