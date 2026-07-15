// ── VoiceReplyStream state machine (psfn-framework-mmo9.8.1) ──
//
//   begin(turnId, cancellationId)
//     → provisionalDelta(text)*      // telemetry ONLY — NEVER releasable to TTS
//     → committedSegment(text, seq)* // the ONLY thing a TTS sink may speak
//     → final(content) | abort(reason)
//
// LAW 18 (load-bearing, non-negotiable): provisional/uncommitted text is never
// returned to a caller as speakable. Only committed segments are exposed. The
// ordered concatenation of committed segments MUST equal the disposed
// `final.content`; finalize() asserts this and THROWS on divergence — the
// fail-closed reconciliation tripwire.
//
// Pipeline per turn (all pure, no I/O):
//   raw delta → streaming stamp strip (ingest) → segmenter (bounded look-ahead)
//             → per-segment content gates → committed segment (or forward-abort)
//
// The streaming stamp stripper is applied on ingest so committed text equals
// stripLeadingHistoryStamps(rawDeltas) — exactly the transform the final-only
// outbound seam applies to `content` — which is what makes reconciliation hold
// by construction.

import { createStreamingHistoryStampStripper } from '../../../shared/utils/history-stamp-hygiene.js';
import { evaluateSegmentGates } from './content-gate.js';
import { createReplySegmenter } from './segmenter.js';
import type {
  AbortResult,
  CommittedSegment,
  FinalResult,
  PushResult,
  ReplyStreamAbortReason,
  ReplyStreamState,
  VoiceReplyStream,
  VoiceReplyStreamOptions,
} from './types.js';

/** Fail-closed error thrown when committed text diverges from disposed content. */
export class ReplyStreamReconciliationError extends Error {
  constructor(
    readonly committed: string,
    readonly finalContent: string,
  ) {
    super(
      'VoiceReplyStream reconciliation failed: committed segment concatenation '
      + 'does not equal final content (Law 18 tripwire).',
    );
    this.name = 'ReplyStreamReconciliationError';
  }
}

export function createVoiceReplyStream(options: VoiceReplyStreamOptions): VoiceReplyStream {
  const stripper = createStreamingHistoryStampStripper();
  const segmenter = createReplySegmenter(options.segmenter);

  let state: ReplyStreamState = 'idle';
  let turnId = '';
  let cancellationId = '';
  let seq = 0;

  const committed: CommittedSegment[] = [];
  let committedConcat = '';
  // Every stripped delta seen, for the defensive prefix invariant.
  let accumulatedStripped = '';

  function requireState(expected: ReplyStreamState, op: string): void {
    if (state !== expected) {
      throw new Error(`VoiceReplyStream.${op} requires state '${expected}' but was '${state}'`);
    }
  }

  /** Gate + commit already-confirmed segment texts. Returns committed + abort. */
  function commitSegments(segments: readonly string[]): PushResult {
    const out: CommittedSegment[] = [];
    for (const text of segments) {
      const outcome = evaluateSegmentGates({
        cumulativeCommitted: committedConcat,
        candidate: text,
        config: options.gate,
      });
      if (outcome.action === 'abort') {
        state = 'aborted';
        return { committed: out, aborted: { reason: outcome.reason } };
      }
      const segment: CommittedSegment = { seq: seq++, text, turnId, cancellationId };
      committed.push(segment);
      committedConcat += text;
      // Defensive Law-18 invariant: everything committed is a verbatim in-order
      // prefix of the stripped generation. Never false by construction.
      if (!accumulatedStripped.startsWith(committedConcat)) {
        throw new ReplyStreamReconciliationError(committedConcat, accumulatedStripped);
      }
      out.push(segment);
    }
    return { committed: out };
  }

  return {
    get state(): ReplyStreamState {
      return state;
    },
    get committedSegments(): readonly CommittedSegment[] {
      return committed;
    },
    get committedContent(): string {
      return committedConcat;
    },

    begin(nextTurnId: string, nextCancellationId: string): void {
      requireState('idle', 'begin');
      if (!nextTurnId) throw new Error('VoiceReplyStream.begin requires a non-empty turnId');
      if (!nextCancellationId) throw new Error('VoiceReplyStream.begin requires a non-empty cancellationId');
      turnId = nextTurnId;
      cancellationId = nextCancellationId;
      state = 'streaming';
    },

    pushDelta(text: string): PushResult {
      requireState('streaming', 'pushDelta');
      // Provisional delta: telemetry ONLY, never returned as speakable (Law 18).
      options.onProvisionalDelta?.(text);
      const stripped = stripper.push(text);
      accumulatedStripped += stripped;
      const segments = segmenter.push(stripped);
      return commitSegments(segments);
    },

    finalize(finalContent: string): FinalResult | AbortResult {
      requireState('streaming', 'finalize');
      const flushed = stripper.flush();
      if (flushed.length > 0) {
        accumulatedStripped += flushed;
        segmenter.push(flushed);
      }
      const tail = segmenter.flush();
      const result = commitSegments(tail);
      if (result.aborted) {
        return { kind: 'abort', reason: result.aborted.reason, segments: committed };
      }
      // Fail-closed reconciliation tripwire (Law 18).
      if (committedConcat !== finalContent) {
        throw new ReplyStreamReconciliationError(committedConcat, finalContent);
      }
      state = 'finalized';
      return { kind: 'final', content: committedConcat, segments: committed };
    },

    abort(reason: ReplyStreamAbortReason = 'external'): AbortResult {
      if (state === 'aborted') {
        return { kind: 'abort', reason, segments: committed };
      }
      if (state !== 'streaming') {
        throw new Error(`VoiceReplyStream.abort requires state 'streaming' but was '${state}'`);
      }
      state = 'aborted';
      return { kind: 'abort', reason, segments: committed };
    },
  };
}
