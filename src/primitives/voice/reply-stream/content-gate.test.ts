import { describe, expect, it } from 'vitest';
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

  it('forward-aborts on a missing-image-attachment claim', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image.',
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

  it('catches a contradiction phrase that straddles a segment boundary', () => {
    // "are you" already committed, "sure" arrives in the candidate.
    expect(evaluateSegmentGates({
      cumulativeCommitted: 'Wait, are you ',
      candidate: 'sure about that?',
      config: ANCHORED,
    })).toEqual({ action: 'abort', reason: 'runtime_datetime_contradiction' });
  });

  it('prioritizes the image-claim reason deterministically', () => {
    expect(evaluateSegmentGates({
      cumulativeCommitted: '',
      candidate: 'Here is the attached image, but are you sure the clock is right?',
      config: ANCHORED,
    })).toEqual({ action: 'abort', reason: 'missing_image_attachment_claim' });
  });
});
