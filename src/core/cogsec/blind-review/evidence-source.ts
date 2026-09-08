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
//      `structural_only` row with an empty excerpt.
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

/** Bounded tool-name list per evidence row; names are identifiers, not content. */
const MAX_TOOL_NAMES_PER_ITEM = 12;

/** The narrow read surface this adapter needs from the live session runtime. */
export interface BlindReviewTurnRecordReader {
  listRecentSessions(limit: number): Array<{ sessionId: string; sourceChannelId: string }>;
  getRecentSourceTurnRecords(sourceChannelId: string, limit: number): TurnRecord[];
  isSessionRetiredOrQuarantined(sessionId: string): boolean;
}

export interface BlindReviewEvidenceSourceOptions {
  reader: BlindReviewTurnRecordReader;
  recentSessionLimit: number;
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
  const actor = privacy.contentSensitivityActor;
  if (!actor || actor.kind !== 'companion') return false;
  return actor.turnId === record.turnId && actor.requestId === record.requestId;
}

function toActivitySignals(record: TurnRecord): BlindReviewActivitySignals {
  const toolNames = [...new Set(record.toolCalls.map(call => call.toolName))]
    .sort()
    .slice(0, MAX_TOOL_NAMES_PER_ITEM);
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

/**
 * Build the excerpt. Assistant reply first, then the rationales the companion
 * attached to her tool calls — that ordering keeps the bounded budget spent on
 * the reasoning most likely to carry drift. Blinding runs on the joined text so
 * a cue split across two fragments is still reduced.
 */
function toBlindedExcerpt(record: TurnRecord, maxChars: number): string {
  const fragments: string[] = [];
  const assistant = record.assistantMessage?.content.trim();
  if (assistant) fragments.push(assistant);
  for (const call of record.toolCalls) {
    const rationale = call.rationale?.trim();
    if (rationale) fragments.push(rationale);
  }
  if (fragments.length === 0) return '';
  return blindPublicStimulus(fragments.join(' ')).slice(0, maxChars);
}

function toEvidenceItem(record: TurnRecord, maxBlindedCharsPerItem: number): BlindReviewEvidenceItem {
  const activity = toActivitySignals(record);
  const blindedExcerpt = permitsBlindedExcerpt(record)
    ? toBlindedExcerpt(record, maxBlindedCharsPerItem)
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
  const { reader, recentSessionLimit } = options;
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
          items.push(toEvidenceItem(record, input.maxBlindedCharsPerItem));
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
