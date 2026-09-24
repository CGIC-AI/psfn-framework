import { describe, expect, it } from 'vitest';
import { healMissingImageAttachmentClaim } from '../../images/attachment-claim-guard.js';
import { evaluateSegmentGates } from './content-gate.js';
import type { ContentGateConfig } from './types.js';

const ANCHORED: ContentGateConfig = {
  attachmentCount: 0,
  datetimePromptContext: { assembledPrompt: 'You are here. <current_datetime>2026-07-15</current_datetime>' },
};
const NO_ANCHOR: ContentGateConfig = { attachmentCount: 0, datetimePromptContext: null };

describe('evaluateSegmentGates', () => {
  it('commits benign text', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Sure, the sky is blue today.',
      config: ANCHORED,
    })).toEqual({ action: 'commit' });
  });

  it('heals a claim-only candidate to nothing instead of aborting', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image.',
      config: NO_ANCHOR,
    })).toEqual({ action: 'heal', text: '', reason: 'missing_image_attachment_claim' });
  });

  it('heals the claim out of one delta while preserving the safe text around it', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: 'Hi. ',
      candidate: 'Sure thing. Here is the attached image. Anything else?',
      config: NO_ANCHOR,
    })).toEqual({
      action: 'heal',
      text: 'Sure thing. Anything else?',
      reason: 'missing_image_attachment_claim',
    });
  });

  it('matches the canonical batch healer for a marker claim', () => {
    const candidate = 'A sunny beach.\n*image attached*\nEnjoy!';
    expect(evaluateSegmentGates({ cumulativeCommitted: '', candidate, config: NO_ANCHOR }))
      .toEqual({
        action: 'heal',
        text: healMissingImageAttachmentClaim(candidate),
        reason: 'missing_image_attachment_claim',
      });
  });

  it('still forward-aborts a claim that straddles already-committed text', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: 'Here is the ',
      candidate: 'attached image.',
      config: NO_ANCHOR,
    })).toEqual({ action: 'abort', reason: 'missing_image_attachment_claim' });
  });

  it('does not trip the image gate when an attachment exists', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image.',
      config: { attachmentCount: 1, datetimePromptContext: null },
    })).toEqual({ action: 'commit' });
  });

  it('forward-aborts on a runtime-datetime contradiction when anchored', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'That clock must be off, honestly.',
      config: ANCHORED,
    })).toEqual({ action: 'abort', reason: 'runtime_datetime_contradiction' });
  });

  it('does NOT trip the datetime gate without an anchor (detector is content+anchor local)', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'That clock must be off, honestly.',
      config: NO_ANCHOR,
    })).toEqual({ action: 'commit' });
  });

  it('catches a datetime-adjacent contradiction phrase that straddles a segment boundary', () => {
    // "are you" already committed, "sure" arrives in the candidate; "clock"
    // provides the datetime adjacency the upx0.13 guard requires.
    expect(evaluateSegmentGates({
      cumulativeCommitted: 'Wait, are you ',
      candidate: 'sure the clock is right?',
      config: ANCHORED,
    })).toEqual({ action: 'abort', reason: 'runtime_datetime_contradiction' });
  });

  it('commits a straddling broad phrase with no datetime reference (upx0.13 adjacency contract)', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: 'Wait, are you ',
      candidate: 'sure about that?',
      config: ANCHORED,
    })).toEqual({ action: 'commit' });
  });

  it('runs the datetime detector on the healed text that would actually be spoken', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image, but are you sure the clock is right?',
      config: ANCHORED,
    })).toEqual({ action: 'heal', text: '', reason: 'missing_image_attachment_claim' });
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image. That clock must be off, honestly.',
      config: ANCHORED,
    })).toEqual({ action: 'abort', reason: 'runtime_datetime_contradiction' });
  });
});
