import { describe, expect, it } from 'vitest';
import {
  createStreamingHistoryStampStripper,
  stripLeadingHistoryStamps,
} from './history-stamp-hygiene.js';

const STAMP = '[Mon 07-13-26 14:32]';
const LATER_STAMP = '[Tue 07-14-26 09:05]';

describe('stripLeadingHistoryStamps', () => {
  it('strips a stamp at the start of the reply', () => {
    expect(stripLeadingHistoryStamps(`${STAMP} the kettle just clicked off`))
      .toBe('the kettle just clicked off');
  });

  it('strips a stamp at the start of every line of a multiline reply', () => {
    const input = `${STAMP} first line\nplain middle line\n${LATER_STAMP} last line`;
    expect(stripLeadingHistoryStamps(input))
      .toBe('first line\nplain middle line\nlast line');
  });

  it('strips repeated stamps at one line start', () => {
    expect(stripLeadingHistoryStamps(`${STAMP} ${LATER_STAMP} doubled up`))
      .toBe('doubled up');
    expect(stripLeadingHistoryStamps(`${STAMP}${LATER_STAMP} no separator`))
      .toBe('no separator');
  });

  it('leaves a stamp quoted mid-sentence untouched', () => {
    const input = `you said that at ${STAMP} if I remember right`;
    expect(stripLeadingHistoryStamps(input)).toBe(input);
  });

  it('is a no-op on clean text', () => {
    const input = 'nothing stamped here\nnot on this line either';
    expect(stripLeadingHistoryStamps(input)).toBe(input);
  });

  it('reduces a stamp-only reply to the empty string', () => {
    expect(stripLeadingHistoryStamps(STAMP)).toBe('');
    expect(stripLeadingHistoryStamps(`${STAMP}   `)).toBe('');
  });

  it('leaves near-miss prefixes untouched', () => {
    const wrongCase = '[MON 07-13-26 14:32] shouted weekday';
    const shortDigits = '[Mon 7-13-26 14:32] single-digit month';
    const notAStamp = '[Note to self] plain bracketed prefix';
    expect(stripLeadingHistoryStamps(wrongCase)).toBe(wrongCase);
    expect(stripLeadingHistoryStamps(shortDigits)).toBe(shortDigits);
    expect(stripLeadingHistoryStamps(notAStamp)).toBe(notAStamp);
  });
});

describe('createStreamingHistoryStampStripper', () => {
  function streamAll(chunks: string[]): string {
    const stripper = createStreamingHistoryStampStripper();
    let out = '';
    for (const chunk of chunks) out += stripper.push(chunk);
    return out + stripper.flush();
  }

  it('drops a leading stamp delivered in a single chunk', () => {
    expect(streamAll([`${STAMP} good morning`])).toBe('good morning');
  });

  it('drops a stamp split across chunk boundaries', () => {
    expect(streamAll(['[Mon 07-1', '3-26 14:', '32] good morning'])).toBe('good morning');
  });

  it('drops per-line and repeated stamps like the batch helper', () => {
    expect(streamAll([`${STAMP} ${LATER_STAMP} hi\n`, `${STAMP} again`])).toBe('hi\nagain');
  });

  it('releases a failed candidate verbatim', () => {
    expect(streamAll(['[Mo', 're coffee?'])).toBe('[More coffee?');
  });

  it('leaves a quoted mid-sentence stamp untouched across chunks', () => {
    expect(streamAll(['you said that at [Mon ', '07-13-26 14:32] earlier']))
      .toBe(`you said that at ${STAMP} earlier`);
  });

  it('flush releases a withheld partial stamp at end of block', () => {
    const stripper = createStreamingHistoryStampStripper();
    expect(stripper.push('done for tonight\n[Mon 07-1')).toBe('done for tonight\n');
    expect(stripper.flush()).toBe('[Mon 07-1');
  });

  it('matches the batch helper for every chunk split of representative fixtures', () => {
    const fixtures = [
      `${STAMP} leading stamp reply`,
      `${STAMP} first\n${LATER_STAMP} second\nplain third`,
      `${STAMP}${LATER_STAMP} back to back`,
      `${STAMP}   spaced out`,
      `quoting ${STAMP} mid-sentence stays`,
      'completely clean text\nacross two lines',
      `ends with a partial\n[Mon 07-13`,
      STAMP,
      '',
    ];
    for (const fixture of fixtures) {
      const expected = stripLeadingHistoryStamps(fixture);
      for (let split = 0; split <= fixture.length; split += 1) {
        const streamed = streamAll([fixture.slice(0, split), fixture.slice(split)]);
        expect(streamed, `fixture ${JSON.stringify(fixture)} split at ${split}`).toBe(expected);
      }
    }
  });
});
