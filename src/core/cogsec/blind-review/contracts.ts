// ── Blind Reviewer: evidence, gate, reviewer and store contracts (yxz0z.3) ──
//
// The Blind Reviewer is a CONTINUOUS PASSIVE CogSec observer. It reads bounded
// reasoning/activity evidence that is already durable, evaluates it off the hot
// path, and may raise a content-minimized operator alert. It has no policy
// authority: nothing in this module can withhold, delay, rewrite, cancel or
// block a turn, and no port here returns a decision a caller could act on.
//
// Two disclosure classes exist and only two:
//
//   * `structural_only` — counters and tool names. No message text at all.
//     This is the default and the fail-closed outcome for anything whose
//     recorded audit privacy does not explicitly permit more.
//   * `blinded_excerpt` — the above PLUS a bounded excerpt that has been put
//     through `blindPublicStimulus`, admitted only for turns the companion
//     already classified as verbatim-public and non-intimate.
//
// Raw reasoning never leaves this boundary: the excerpt is blinded and bounded
// at capture, the durable window stores only what capture produced, and an
// alert carries a safe single-line summary plus provenance refs — never the
// evidence text.

import { createHash } from 'node:crypto';

import type { CogSecMode } from '../../../shared/contracts/cogsec-mode.js';

/** Case channel for every Blind Reviewer alert. Never a companion channel. */
export const BLIND_REVIEW_CHANNEL_ID = 'internal:cogsec:blind-review';
/** Actor recorded on every alert this lane raises. */
export const BLIND_REVIEW_ACTOR = 'system:cogsec-blind-review';
/** Durable processor identity for the lane's cursor and review watermark. */
export const BLIND_REVIEW_PROCESSOR = 'cogsec.blind_review';

/** Whether an evidence row carries text at all. */
export type BlindReviewDisclosure = 'structural_only' | 'blinded_excerpt';

/**
 * Content-free activity shape of one turn. Every field is a count or a bounded
 * identifier list: this half of the evidence is safe in any posture, which is
 * why it is what a `structural_only` row consists of entirely.
 */
export interface BlindReviewActivitySignals {
  toolCallCount: number;
  /** Sorted, de-duplicated, bounded tool identifiers. Names only, no arguments. */
  toolNames: string[];
  toolErrorCount: number;
  /** Length of the turn's own text. The text itself is not carried here. */
  assistantChars: number;
  userChars: number;
  extractedMemoryCount: number;
  durationMs: number;
}

/** One bounded, already-safe unit of review evidence. */
export interface BlindReviewEvidenceItem {
  /** Deterministic digest of `sourceRef`; the durable primary key. */
  evidenceId: string;
  /** `turn://<channelId>/<turnId>` — a pointer, never content. */
  sourceRef: string;
  occurredAtMs: number;
  disclosure: BlindReviewDisclosure;
  activity: BlindReviewActivitySignals;
  /** Blinded and bounded at capture. Empty string for `structural_only`. */
  blindedExcerpt: string;
  /** Digest over the normalized evidence, so an unchanged batch is detectable. */
  contentDigest: string;
}

/**
 * Pull-side evidence. The lane POLLS this; nothing on the turn path pushes into
 * it and nothing on the turn path awaits it, which is what makes "the hot path
 * never waits for the reviewer" true by construction rather than by discipline.
 */
export interface BlindReviewEvidenceSourcePort {
  listEvidence(input: {
    sinceMs: number;
    limit: number;
    maxBlindedCharsPerItem: number;
  }): Promise<BlindReviewEvidenceItem[]>;
}

/** How much concern one reviewed batch raised. `none` never alerts. */
export const BLIND_REVIEW_CONCERN_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type BlindReviewConcernLevel = typeof BLIND_REVIEW_CONCERN_LEVELS[number];

export function isBlindReviewConcernLevel(value: unknown): value is BlindReviewConcernLevel {
  return typeof value === 'string'
    && (BLIND_REVIEW_CONCERN_LEVELS as readonly string[]).includes(value);
}

/**
 * The reviewer's whole output. Deliberately has no action, verdict, hold or
 * block field: there is no shape in which a review result could be mistaken for
 * an enforcement decision.
 */
export interface BlindReviewFinding {
  concernLevel: BlindReviewConcernLevel;
  confidence: number;
  /** Single-line, safe-text summary. Never quotes the evidence. */
  safeSummary: string;
  model: string;
}

export interface BlindReviewRequest {
  /** Stamped onto provenance only. The reviewer's behavior does not vary by it. */
  mode: CogSecMode;
  items: readonly BlindReviewEvidenceItem[];
  maxOutputTokens: number;
  deadlineMs: number;
  costCeilingUsd: number;
}

export interface BlindReviewerPort {
  review(request: BlindReviewRequest): Promise<BlindReviewFinding>;
}

/** Durable lane state: where ingest reached, and what was last reviewed. */
export interface BlindReviewLaneState {
  /** `occurredAtMs` of the newest ingested evidence, or 0 before first ingest. */
  ingestedThroughMs: number;
  /** Digest of the last batch a model actually reviewed, or null. */
  lastBatchDigest: string | null;
  /** Consecutive failed review attempts for the current head batch. */
  reviewAttempt: number;
  /** Earliest time a failed batch may be retried. 0 when nothing is backing off. */
  retryNotBeforeMs: number;
  updatedAtMs: number;
}

export interface BlindReviewPruneRequest {
  nowMs: number;
  retentionMs: number;
  maxRows: number;
}

export interface BlindReviewPruneResult {
  /** Unpinned rows removed for age. */
  expired: number;
  /** Unpinned rows removed to hold the window at `maxRows`. */
  evicted: number;
}

export interface BlindReviewPinResult {
  pinned: number;
  /** Rows the pin ceiling refused. Non-zero is an operator-visible error. */
  refused: number;
}

/**
 * Durable rolling window. Postgres-backed in production; the port exists so the
 * gate and lane can be proven without a container.
 */
export interface BlindReviewStorePort {
  /** Idempotent on `evidenceId`. Returns how many rows were newly admitted. */
  appendEvidence(items: readonly BlindReviewEvidenceItem[], capturedAtMs: number): Promise<number>;
  readState(): Promise<BlindReviewLaneState>;
  writeState(state: BlindReviewLaneState): Promise<void>;
  /** Oldest-first unreviewed rows, bounded by `limit`. */
  listUnreviewed(limit: number): Promise<BlindReviewEvidenceItem[]>;
  markReviewed(evidenceIds: readonly string[], reviewedAtMs: number): Promise<number>;
  /** Pin rows to a case so retention cannot expire the evidence under it. */
  pinEvidence(input: {
    evidenceIds: readonly string[];
    caseId: string;
    pinnedAtMs: number;
    maxPinnedRows: number;
  }): Promise<BlindReviewPinResult>;
  prune(request: BlindReviewPruneRequest): Promise<BlindReviewPruneResult>;
  /** Window census used by the lane's telemetry and by backpressure proofs. */
  countRows(): Promise<{ total: number; pinned: number; unreviewed: number }>;
  close(): Promise<void>;
}

/** Empty state for a lane that has never run. */
export function emptyBlindReviewLaneState(nowMs: number): BlindReviewLaneState {
  return {
    ingestedThroughMs: 0,
    lastBatchDigest: null,
    reviewAttempt: 0,
    retryNotBeforeMs: 0,
    updatedAtMs: nowMs,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic evidence identity. Re-ingesting the same turn is a no-op. */
export function blindReviewEvidenceId(sourceRef: string): string {
  return sha256Hex(sourceRef).slice(0, 32);
}

/** `turn://<channelId>/<turnId>`; matches the CogSec event ref pattern. */
export function blindReviewSourceRef(channelId: string, turnId: string): string {
  return `turn://${encodeURIComponent(channelId)}/${encodeURIComponent(turnId)}`;
}

/**
 * Digest over exactly what a reviewer would see. Two batches with identical
 * evidence produce identical digests, which is what lets the change gate refuse
 * a model call without asking a model anything.
 */
export function blindReviewContentDigest(input: {
  disclosure: BlindReviewDisclosure;
  activity: BlindReviewActivitySignals;
  blindedExcerpt: string;
}): string {
  return sha256Hex(JSON.stringify([
    input.disclosure,
    input.activity.toolCallCount,
    input.activity.toolNames,
    input.activity.toolErrorCount,
    input.activity.assistantChars,
    input.activity.userChars,
    input.activity.extractedMemoryCount,
    input.activity.durationMs,
    input.blindedExcerpt,
  ]));
}

/** Digest over an ordered batch of evidence. Order-sensitive by design. */
export function blindReviewBatchDigest(items: readonly BlindReviewEvidenceItem[]): string {
  return sha256Hex(items.map(item => item.contentDigest).join(' '));
}
