// ── Per-segment content-gate runner (psfn-framework-mmo9.8.1) ──
//
// Runs the two content-LOCAL after-gates on each candidate segment before it is
// committed. Both detectors are IMPORTED from their canonical homes — never
// forked — so the streamed path and the final-only path decide identically.
//
//   #15 image-claim    — rejectsMissingImageAttachmentClaim (attachment-claim-guard)
//   #7/#8 datetime      — detectRuntimeDatetimeContradiction, DETECTOR-ONLY
//
// The datetime detector is content-local (verified against
// runtime-datetime-contradiction-guard.ts): the anchor is a pure function of
// the turn-constant prompt snapshot and the contradiction is a pure regex over
// the asserted text. Its regenerate/refuse REMEDIATION is intentionally NOT run
// here — on the committed streamed path a trip forward-aborts (we never speak
// the contradicting segment) rather than re-prompting after text is spoken.
//
// Gates are evaluated on `cumulativeCommitted + candidate`, not the candidate
// alone, so a trigger phrase that straddles a segment boundary is still caught.
//
// The leading history-stamp strip (#5/#12) is NOT a member of this runner: it is
// applied on ingest by the reply-stream via the repo's streaming stamp stripper
// (createStreamingHistoryStampStripper), which is proven equivalent to the batch
// stripLeadingHistoryStamps and — unlike a per-segment batch strip — cannot
// mis-strip a mid-line stamp that a segment boundary would otherwise expose,
// preserving exact reconciliation.

import { detectRuntimeDatetimeContradiction } from '../../../core/agent/substrate-agent/runtime-datetime-contradiction-guard.js';
import {
  healMissingImageAttachmentClaim,
  rejectsMissingImageAttachmentClaim,
} from '../../images/attachment-claim-guard.js';
import type { ContentGateConfig, ContentGateOutcome } from './types.js';

export function evaluateSegmentGates(input: {
  readonly cumulativeCommitted: string;
  readonly candidate: string;
  readonly config: ContentGateConfig;
}): ContentGateOutcome {
  const { config } = input;
  let candidate = input.candidate;
  let healed = false;

  // #15 image-claim. Heal with the canonical batch healer (psfn-framework-d1f1x)
  // so an unsupported claim is never spoken but the safe text around it is.
  // A claim that is not contained in the candidate alone (it straddles text
  // already committed) cannot be healed without having been partly spoken, so
  // it still forward-aborts.
  if (rejectsMissingImageAttachmentClaim({
    responseText: input.cumulativeCommitted + candidate,
    attachmentCount: config.attachmentCount,
  })) {
    candidate = healMissingImageAttachmentClaim(candidate);
    healed = true;
    if (rejectsMissingImageAttachmentClaim({
      responseText: input.cumulativeCommitted + candidate,
      attachmentCount: config.attachmentCount,
    })) {
      return { action: 'abort', reason: 'missing_image_attachment_claim' };
    }
  }

  // #7/#8 datetime — detector only, on exactly the text that would be spoken.
  if (config.datetimePromptContext !== null) {
    const detection = detectRuntimeDatetimeContradiction(
      config.datetimePromptContext,
      input.cumulativeCommitted + candidate,
    );
    if (detection.contradictionDetected) {
      return { action: 'abort', reason: 'runtime_datetime_contradiction' };
    }
  }

  return healed
    ? { action: 'heal', text: candidate, reason: 'missing_image_attachment_claim' }
    : { action: 'commit' };
}
