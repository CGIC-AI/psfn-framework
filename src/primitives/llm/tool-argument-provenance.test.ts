import { describe, it, expect } from 'vitest';
import { classifyToolArgumentProvenance } from './client.js';

// gu8m: empty-argument tool-call provenance classification. Makes future incidents
// attributable from logs alone — distinguishing a genuine no-arg call from a stream
// accumulation drop from an ordinary schema rejection.
describe('classifyToolArgumentProvenance', () => {
  it('classifies empty args with zero streamed fragment bytes as provider_emitted_empty', () => {
    expect(classifyToolArgumentProvenance({ args: {}, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
    expect(classifyToolArgumentProvenance({ args: undefined, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
    expect(classifyToolArgumentProvenance({ args: null, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
  });

  it('classifies empty args with streamed fragment bytes as stream_parse_dropped', () => {
    // The pre-patch failure mode: argument fragments were on the wire (e.g. the orphaned
    // blank block) yet the named tool call ended up with {}.
    expect(classifyToolArgumentProvenance({ args: {}, argumentFragmentBytes: 42 }))
      .toBe('stream_parse_dropped');
  });

  it('classifies non-empty args as validation_rejected (a real schema mismatch)', () => {
    expect(classifyToolArgumentProvenance({ args: { action: 'list' }, argumentFragmentBytes: 0 }))
      .toBe('validation_rejected');
    expect(classifyToolArgumentProvenance({ args: { tools: 'north_star' }, argumentFragmentBytes: 99 }))
      .toBe('validation_rejected');
  });
});
