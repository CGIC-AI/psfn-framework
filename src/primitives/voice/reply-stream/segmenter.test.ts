import { describe, expect, it } from 'vitest';
import { createReplySegmenter } from './segmenter.js';
import type { SegmenterConfig } from './types.js';

const TEST_SEGMENTER_CONFIG: SegmenterConfig = {
  minSegmentLength: 24,
  maxBufferLength: 240,
};

/** Feed text one char at a time (worst-case chunking) and collect all output. */
function runCharwise(text: string, config: SegmenterConfig = TEST_SEGMENTER_CONFIG): string[] {
  const seg = createReplySegmenter(config);
  const out: string[] = [];
  for (const ch of text) out.push(...seg.push(ch));
  out.push(...seg.flush());
  return out;
}

/** Feed the whole text in one push, then flush. */
function runWhole(text: string, config: SegmenterConfig = TEST_SEGMENTER_CONFIG): string[] {
  const seg = createReplySegmenter(config);
  const out = [...seg.push(text)];
  out.push(...seg.flush());
  return out;
}

describe('createReplySegmenter — exact concatenation (Law 18 reconciliation basis)', () => {
  const texts = [
    'Hello there. How are you doing today? I am fine, thanks.',
    'The value is 3.14 and the total is $2,500.00 exactly here.',
    'Dr. Smith met Mr. Jones at 5 p.m. yesterday for a long chat.',
    'One sentence only without any terminator at the end here',
    'Line one here now\nLine two here now\nLine three is the last',
    '',
    'Yes.',
  ];
  it.each(texts)('reassembles exactly (charwise) %j', (text) => {
    expect(runCharwise(text).join('')).toBe(text);
  });
  it.each(texts)('reassembles exactly (whole) %j', (text) => {
    expect(runWhole(text).join('')).toBe(text);
  });
  it.each(texts)('charwise and whole feeding agree %j', (text) => {
    expect(runCharwise(text)).toEqual(runWhole(text));
  });
});

describe('createReplySegmenter — never emits a mid-token fragment', () => {
  it('breaks a decimal-heavy runaway only at whitespace/clause, never mid-number', () => {
    const text = 'The reading was 3.14159 then 2.71828 then 1.41421 then 1.61803 then 0.57721 done here';
    const segments = runWhole(text, { minSegmentLength: 8, maxBufferLength: 32 });
    expect(segments.join('')).toBe(text);
    for (const seg of segments.slice(0, -1)) {
      // every non-final segment ends at whitespace (word/clause break) — no split token
      expect(/\s$/.test(seg)).toBe(true);
    }
    // no segment splits a decimal number
    for (const seg of segments) {
      expect(seg).not.toMatch(/\d\.$/);
      expect(seg).not.toMatch(/^\.\d/);
    }
  });

  it('does not break inside abbreviations', () => {
    const segments = runWhole('Please meet Dr. Smith and Mr. Jones now for the meeting today.', {
      minSegmentLength: 4,
      maxBufferLength: 200,
    });
    // The whole thing is one sentence; abbreviations must not create a break.
    expect(segments).toEqual(['Please meet Dr. Smith and Mr. Jones now for the meeting today.']);
  });

  it('does not break inside a decimal', () => {
    const segments = runWhole('Pi is 3.14 today.', { minSegmentLength: 1, maxBufferLength: 200 });
    expect(segments).toEqual(['Pi is 3.14 today.']);
  });
});

describe('createReplySegmenter — sentence boundaries with bounded look-ahead', () => {
  it('splits complete sentences at confirmed boundaries', () => {
    const segments = runWhole('First sentence here now. Second sentence here too. Third one here.', {
      minSegmentLength: 8,
      maxBufferLength: 200,
    });
    expect(segments).toEqual([
      'First sentence here now. ',
      'Second sentence here too. ',
      'Third one here.',
    ]);
  });

  it('withholds a terminator until whitespace confirms it (mid-stream)', () => {
    const seg = createReplySegmenter({ minSegmentLength: 4, maxBufferLength: 200 });
    // "Wait." with no following char yet — not confirmed, nothing released.
    expect(seg.push('Wait for it here.')).toEqual([]);
    // whitespace arrives → boundary confirmed and released.
    expect(seg.push(' Next.')).toEqual(['Wait for it here. ']);
    expect(seg.flush()).toEqual(['Next.']);
  });
});

describe('createReplySegmenter — min-length floor', () => {
  it('merges sub-floor sentences forward mid-stream', () => {
    const seg = createReplySegmenter({ minSegmentLength: 20, maxBufferLength: 200 });
    // "Hi. Yo. " are each below the floor; they merge until the floor is met.
    const out = seg.push('Hi. Yo. This part crosses the floor now. ');
    expect(out).toEqual(['Hi. Yo. This part crosses the floor now. ']);
  });

  it('relaxes the floor at flush so short tails still emit', () => {
    expect(runWhole('Ok.', { minSegmentLength: 50, maxBufferLength: 200 })).toEqual(['Ok.']);
  });
});

describe('createReplySegmenter — runaway relief', () => {
  it('forces a clause break when the buffer exceeds the cap with no sentence end', () => {
    const text = 'this clause keeps going, and going further along, and further still along here';
    const segments = runWhole(text, { minSegmentLength: 8, maxBufferLength: 40 });
    expect(segments.join('')).toBe(text);
    expect(segments.length).toBeGreaterThan(1);
    // first forced break lands on a clause terminator + whitespace
    expect(segments[0]).toMatch(/,\s$/);
  });

  it('forces a word break when there is no clause terminator', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm';
    const segments = runWhole(text, { minSegmentLength: 8, maxBufferLength: 24 });
    expect(segments.join('')).toBe(text);
    for (const seg of segments.slice(0, -1)) {
      expect(/\s$/.test(seg)).toBe(true); // ended at a whitespace, never mid-word
    }
  });

  it('never splits a single spaceless runaway token', () => {
    const text = 'a'.repeat(100);
    const seg = createReplySegmenter({ minSegmentLength: 8, maxBufferLength: 24 });
    expect(seg.push(text)).toEqual([]); // cannot break without splitting a token
    expect(seg.flush()).toEqual([text]);
  });
});

describe('createReplySegmenter — config guard', () => {
  it.each([
    { minSegmentLength: 0, maxBufferLength: 240 },
    { minSegmentLength: 24, maxBufferLength: 0 },
    { minSegmentLength: 1.5, maxBufferLength: 240 },
  ])('rejects non-positive or non-integer thresholds: %j', (config) => {
    expect(() => createReplySegmenter(config)).toThrow(/positive safe integer/u);
  });

  it('rejects maxBufferLength <= minSegmentLength', () => {
    expect(() => createReplySegmenter({ minSegmentLength: 50, maxBufferLength: 50 })).toThrow();
  });
});
