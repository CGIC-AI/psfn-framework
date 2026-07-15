import { describe, expect, it, vi } from 'vitest';
import { createVoiceReplyStream, ReplyStreamReconciliationError } from './reply-stream.js';
import type { ContentGateConfig, VoiceReplyStreamOptions } from './types.js';

const NO_ANCHOR: ContentGateConfig = { attachmentCount: 0, datetimePromptContext: null };
const ANCHORED: ContentGateConfig = {
  attachmentCount: 0,
  datetimePromptContext: { assembledPrompt: '<current_datetime>2026-07-15</current_datetime>' },
};

function opts(overrides: Partial<VoiceReplyStreamOptions> = {}): VoiceReplyStreamOptions {
  return {
    gate: NO_ANCHOR,
    segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
    ...overrides,
  };
}

describe('VoiceReplyStream — happy path + reconciliation (Law 18 tripwire)', () => {
  it('commits segments and reconciles final content == committed concatenation', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    const p1 = stream.pushDelta('Hello there. ');
    const p2 = stream.pushDelta('How are you? ');
    expect(p1.committed.map((s) => s.text)).toEqual(['Hello there. ']);
    expect(p2.committed.map((s) => s.text)).toEqual(['How are you? ']);

    const result = stream.finalize('Hello there. How are you? ');
    expect(result.kind).toBe('final');
    if (result.kind !== 'final') throw new Error('unreachable');
    expect(result.content).toBe('Hello there. How are you? ');
    expect(result.segments.map((s) => s.text).join('')).toBe(result.content);
    expect(result.segments.map((s) => s.seq)).toEqual([0, 1]);
    expect(stream.state).toBe('finalized');
  });

  it('carries turnId/cancellationId onto every committed segment', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('turn-x', 'cancel-x');
    const { committed } = stream.pushDelta('Ready to go now. ');
    expect(committed[0]).toMatchObject({ turnId: 'turn-x', cancellationId: 'cancel-x', seq: 0 });
  });

  it('THROWS a reconciliation error when committed text diverges from final content', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    stream.pushDelta('Hello there. ');
    expect(() => stream.finalize('Something else entirely.')).toThrow(ReplyStreamReconciliationError);
  });

  it('flushes a sub-floor tail at finalize', () => {
    const stream = createVoiceReplyStream(opts({ segmenter: { minSegmentLength: 100, maxBufferLength: 200 } }));
    stream.begin('t1', 'c1');
    expect(stream.pushDelta('Yes.').committed).toEqual([]); // below floor, buffered
    const result = stream.finalize('Yes.');
    expect(result.kind).toBe('final');
    if (result.kind !== 'final') throw new Error('unreachable');
    expect(result.segments.map((s) => s.text)).toEqual(['Yes.']);
  });
});

describe('VoiceReplyStream — leading history-stamp strip on ingest', () => {
  it('strips a mimicked leading stamp; committed text is the stripped content', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    stream.pushDelta('[Mon 07-14-26 13:45] Hello there friend. ');
    // Final content is the disposed (already stamp-stripped) content.
    const result = stream.finalize('Hello there friend. ');
    expect(result.kind).toBe('final');
    if (result.kind !== 'final') throw new Error('unreachable');
    expect(result.content).toBe('Hello there friend. ');
    expect(result.content).not.toContain('[Mon');
  });
});

describe('VoiceReplyStream — provisional deltas are telemetry ONLY (Law 18)', () => {
  it('reports raw deltas to the telemetry sink but never as committed', () => {
    const seen: string[] = [];
    const stream = createVoiceReplyStream(opts({ onProvisionalDelta: (d) => seen.push(d) }));
    stream.begin('t1', 'c1');
    stream.pushDelta('[Mon 07-14-26 13:45] Hi. ');
    stream.pushDelta('There. ');
    // Raw deltas (including the un-stripped stamp) went to telemetry only.
    expect(seen).toEqual(['[Mon 07-14-26 13:45] Hi. ', 'There. ']);
    // committed content never contains provisional/un-stripped text.
    expect(stream.committedContent).not.toContain('[Mon');
  });

  it('committed content is always a verbatim in-order prefix of the reply', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    const full = 'First part here now. Second part here now. Third part here now. ';
    let fed = '';
    for (const ch of full) {
      fed += ch;
      stream.pushDelta(ch);
      expect(fed.startsWith(stream.committedContent)).toBe(true);
    }
  });
});

describe('VoiceReplyStream — content-gate forward-abort', () => {
  it('forward-aborts on a datetime contradiction and never commits the offending segment', () => {
    const stream = createVoiceReplyStream(opts({ gate: ANCHORED }));
    stream.begin('t1', 'c1');
    const committedFirst = stream.pushDelta('The current time reads fine. ');
    expect(committedFirst.committed.map((s) => s.text)).toEqual(['The current time reads fine. ']);

    const aborted = stream.pushDelta('Are you sure about it? ');
    expect(aborted.committed).toEqual([]);
    expect(aborted.aborted).toEqual({ reason: 'runtime_datetime_contradiction' });
    expect(stream.state).toBe('aborted');
    // the contradiction was never spoken
    expect(stream.committedContent).toBe('The current time reads fine. ');
    // further pushes are rejected fail-closed
    expect(() => stream.pushDelta('more')).toThrow();
  });

  it('forward-aborts on a missing-image-attachment claim', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    const result = stream.pushDelta('Here is the attached image. ');
    expect(result.aborted).toEqual({ reason: 'missing_image_attachment_claim' });
    expect(stream.state).toBe('aborted');
  });

  it('forward-aborts at finalize if the tail trips a gate', () => {
    const stream = createVoiceReplyStream(opts({ gate: ANCHORED, segmenter: { minSegmentLength: 100, maxBufferLength: 400 } }));
    stream.begin('t1', 'c1');
    stream.pushDelta('The clock must be off entirely'); // buffered (sub-floor, no terminator)
    const result = stream.finalize('The clock must be off entirely');
    expect(result.kind).toBe('abort');
    if (result.kind !== 'abort') throw new Error('unreachable');
    expect(result.reason).toBe('runtime_datetime_contradiction');
    expect(stream.state).toBe('aborted');
  });
});

describe('VoiceReplyStream — barge-in / abort', () => {
  it('aborts from streaming and preserves already-committed segments', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    stream.pushDelta('Hello there. ');
    const result = stream.abort('cancelled');
    expect(result.kind).toBe('abort');
    expect(result.reason).toBe('cancelled');
    expect(result.segments.map((s) => s.text)).toEqual(['Hello there. ']);
    expect(stream.state).toBe('aborted');
  });

  it('abort is idempotent once aborted', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    stream.abort('cancelled');
    expect(() => stream.abort('external')).not.toThrow();
    expect(stream.state).toBe('aborted');
  });
});

describe('VoiceReplyStream — state-machine guards (fail closed)', () => {
  it('rejects pushDelta before begin', () => {
    const stream = createVoiceReplyStream(opts());
    expect(() => stream.pushDelta('x')).toThrow();
  });

  it('rejects a second begin', () => {
    const stream = createVoiceReplyStream(opts());
    stream.begin('t1', 'c1');
    expect(() => stream.begin('t2', 'c2')).toThrow();
  });

  it('rejects empty identifiers on begin', () => {
    expect(() => createVoiceReplyStream(opts()).begin('', 'c1')).toThrow();
    expect(() => createVoiceReplyStream(opts()).begin('t1', '')).toThrow();
  });

  it('rejects finalize before begin and after finalize', () => {
    const stream = createVoiceReplyStream(opts());
    expect(() => stream.finalize('x')).toThrow();
    stream.begin('t1', 'c1');
    stream.pushDelta('Hi there now. ');
    stream.finalize('Hi there now. ');
    expect(() => stream.finalize('Hi there now. ')).toThrow();
  });

  it('rejects abort from idle and after finalize', () => {
    const idle = createVoiceReplyStream(opts());
    expect(() => idle.abort()).toThrow();
    const done = createVoiceReplyStream(opts());
    done.begin('t1', 'c1');
    done.pushDelta('Hi there now. ');
    done.finalize('Hi there now. ');
    expect(() => done.abort()).toThrow();
  });

  it('does not leak provisional deltas through pushDelta when the sink throws is not swallowed', () => {
    const stream = createVoiceReplyStream(opts({ onProvisionalDelta: () => { throw new Error('sink boom'); } }));
    stream.begin('t1', 'c1');
    // A throwing telemetry sink must surface (no swallowed errors).
    expect(() => stream.pushDelta('Hi.')).toThrow('sink boom');
    vi.restoreAllMocks();
  });
});
