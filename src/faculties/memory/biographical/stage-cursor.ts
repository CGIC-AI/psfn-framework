// ── Durable background-stage cursors (psfn-framework-o61vb.16) ──
//
// Biography synthesis and companion review are heavy background stages. Running
// them on a timer is cheap only if an unchanged window costs nothing, so each
// stage records a digest of exactly what it last processed for one scan key and
// compares it before doing any model work.
//
// A cursor is content-free by construction: the key is a canonical subject or
// candidate identity and the value is a digest of the inputs, never their text.
// That is what lets these rows survive restart and cross the fleet baton
// without becoming a disclosure channel.

import { createHash } from 'node:crypto';

import { isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import { assertMemoryListPosition, type MemoryListPosition } from '../list-position.js';

interface BiographySourceScanProgress {
  readonly pageIndex: number;
  readonly before: MemoryListPosition;
}

const BIOGRAPHY_STAGES = [
  'biography_synthesis',
  'biography_companion_review',
] as const;
export type BiographyStage = (typeof BIOGRAPHY_STAGES)[number];

export interface BiographyStageCursor {
  readonly stage: BiographyStage;
  /** Canonical scan key — a subject or candidate identity, never content. */
  readonly cursorKey: string;
  /** Digest of the exact inputs this stage last processed for that key. */
  readonly observedDigest: string;
  readonly observedAt: string;
  /** Next bounded source page; absent means start a new newest-first cycle. */
  readonly sourceScan?: BiographySourceScanProgress;
}

export interface BiographyStageCursorWriteInput {
  readonly stage: BiographyStage;
  readonly cursorKey: string;
  readonly observedDigest: string;
  readonly now?: Date;
  readonly sourceScan?: BiographySourceScanProgress;
}

export function assertBiographyStage(value: unknown): BiographyStage {
  if (typeof value !== 'string' || !(BIOGRAPHY_STAGES as readonly string[]).includes(value)) {
    throw new Error('unknown biography background stage');
  }
  return value as BiographyStage;
}

export function assertStageCursorKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error('biography stage cursor key must be a non-empty trimmed string');
  }
  return value;
}

function assertStageCursorDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('biography stage cursor digest must be a SHA-256 digest');
  }
  return value;
}

export function deserializeStageCursor(value: unknown): BiographyStageCursor {
  if (!isRecord(value)) throw new Error('stored biography stage cursor must be an object');
  if (typeof value.observedAt !== 'string' || !isCanonicalIsoTimestamp(value.observedAt)) {
    throw new Error('stored biography stage cursor observedAt is invalid');
  }
  const stage = assertBiographyStage(value.stage);
  let sourceScan: BiographySourceScanProgress | undefined;
  if (value.sourceScan !== undefined) {
    if (stage !== 'biography_synthesis' || !isRecord(value.sourceScan)
      || typeof value.sourceScan.pageIndex !== 'number'
      || !Number.isSafeInteger(value.sourceScan.pageIndex) || value.sourceScan.pageIndex < 1) {
      throw new Error('invalid biography source scan progress');
    }
    sourceScan = {
      pageIndex: value.sourceScan.pageIndex,
      before: assertMemoryListPosition(value.sourceScan.before),
    };
  }
  return {
    stage,
    cursorKey: assertStageCursorKey(value.cursorKey),
    observedDigest: assertStageCursorDigest(value.observedDigest),
    observedAt: value.observedAt,
    ...(sourceScan === undefined ? {} : { sourceScan }),
  };
}

/**
 * Digest of an ordered set of opaque identity strings. Used to fingerprint the
 * exact admitted source snapshots a synthesis target had, or the exact
 * candidate revisions a review pass faced: identical inputs digest identically,
 * so the stage can prove there is nothing new without reading any content.
 */
export function computeStageInputDigest(parts: readonly string[]): string {
  const canonical = [...parts].sort().join('\0');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
