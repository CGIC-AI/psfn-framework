// ── Sentence/clause segmenter with bounded look-ahead (psfn-framework-mmo9.8.1) ──
//
// Pure, deterministic, incremental segmenter for committed-segment streaming.
// Guarantees (all unit-tested):
//   - NEVER emits a mid-token fragment: a break is only ever taken at a
//     confirmed sentence/clause boundary or, under runaway relief, at a
//     whitespace boundary.
//   - Exact concatenation: the ordered concatenation of every segment returned
//     by push()+flush() equals the ordered concatenation of the pushed text.
//     No character is dropped, reordered, or duplicated. This is what makes the
//     reply-stream's `final.content == committed concatenation` reconciliation
//     hold by construction (Law 18).
//   - Bounded look-ahead: a sentence boundary is released only once whitespace
//     confirms the terminator (mid-stream) or the round has ended (flush),
//     which distinguishes real sentence ends from decimals/abbreviations/URLs.
//   - min-length floor: mid-stream boundaries shorter than the floor are merged
//     forward to avoid micro-fragments (the floor is relaxed at flush).
//   - runaway relief: once the buffer reaches the max cap with no sentence
//     boundary, a clause break (else a word break) is forced.

import type { SegmenterConfig } from './types.js';

const SENTENCE_TERMINATORS = new Set(['.', '!', '?']);
const CLAUSE_TERMINATORS = new Set([',', ';', ':', '—', '–']);
// Closing quotes/brackets that belong to the sentence they follow.
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»']);

// Lowercase, dot-stripped abbreviations that must not end a sentence.
const BUILTIN_ABBREVIATIONS = new Set<string>([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
  'am', 'pm', 'us', 'uk', 'inc', 'ltd', 'co', 'corp', 'dept', 'fig', 'no',
  'vol', 'al', 'approx', 'gen', 'gov', 'sen', 'rep', 'capt', 'col', 'cmdr',
  'lt', 'sgt', 'rev', 'hon',
]);

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

export interface ReplySegmenter {
  /** Append text and return all segments whose boundary is now confirmed. */
  push(text: string): string[];
  /** Drain the buffer at end-of-round; returns remaining segment(s) in order. */
  flush(): string[];
  /** Current unemitted buffer (for invariants/telemetry only). */
  readonly buffered: string;
}

export function createReplySegmenter(config: SegmenterConfig): ReplySegmenter {
  const { minSegmentLength, maxBufferLength } = config;
  if (!Number.isSafeInteger(minSegmentLength) || minSegmentLength < 1) {
    throw new Error('ReplySegmenter: minSegmentLength must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxBufferLength) || maxBufferLength < 1) {
    throw new Error('ReplySegmenter: maxBufferLength must be a positive safe integer');
  }
  if (!(maxBufferLength > minSegmentLength)) {
    throw new Error(
      `ReplySegmenter: maxBufferLength (${maxBufferLength}) must be greater than minSegmentLength (${minSegmentLength})`,
    );
  }
  const abbreviations = new Set(BUILTIN_ABBREVIATIONS);
  for (const raw of config.extraAbbreviations ?? []) {
    const normalized = raw.replace(/\./g, '').toLowerCase();
    if (normalized) abbreviations.add(normalized);
  }

  let buffer = '';

  function isAbbreviationBefore(dotIndex: number): boolean {
    let p = dotIndex - 1;
    while (p >= 0 && (isLetter(buffer[p]) || buffer[p] === '.')) p--;
    const token = buffer.slice(p + 1, dotIndex).replace(/\./g, '').toLowerCase();
    if (token.length === 0) return false;
    if (abbreviations.has(token)) return true;
    // A single letter before a dot is an initial (e.g. "J." in "J. R. R.").
    return token.length === 1 && isLetter(token);
  }

  /**
   * If a confirmed sentence boundary starts at index `i`, return the cut index
   * (exclusive end of the segment, including trailing closers + whitespace);
   * otherwise -1. `final` treats a terminator at end-of-buffer as confirmed.
   */
  function trySentenceCut(i: number, final: boolean): number {
    const len = buffer.length;
    const ch = buffer[i];

    if (ch === '\n') {
      let k = i;
      while (k < len && isSpace(buffer[k])) k++;
      return k;
    }

    if (!SENTENCE_TERMINATORS.has(ch!)) return -1;

    if (ch === '.') {
      if (isDigit(buffer[i - 1]) && isDigit(buffer[i + 1])) return -1; // decimal
      if (isAbbreviationBefore(i)) return -1;
    }

    let j = i;
    while (j + 1 < len && SENTENCE_TERMINATORS.has(buffer[j + 1]!)) j++;
    while (j + 1 < len && CLOSERS.has(buffer[j + 1]!)) j++;

    let k = j + 1;
    while (k < len && isSpace(buffer[k])) k++;
    if (k > j + 1) return k; // whitespace confirms the boundary
    if (final && j + 1 === len) return len; // terminator at very end, round done
    return -1;
  }

  /** Force a break under runaway: last clause boundary, else last word boundary. */
  function forcedBreak(): number {
    const len = buffer.length;
    let clauseCut = -1;
    for (let p = 0; p < len; p++) {
      const ch = buffer[p]!;
      if (!CLAUSE_TERMINATORS.has(ch)) continue;
      if (ch === ',' && isDigit(buffer[p - 1]) && isDigit(buffer[p + 1])) continue; // 1,000
      let q = p + 1;
      if (q < len && isSpace(buffer[q])) {
        while (q < len && isSpace(buffer[q])) q++;
        clauseCut = q; // keep the latest clause boundary
      }
    }
    if (clauseCut !== -1) return clauseCut;

    // Word break: cut after the last whitespace so no token is split.
    let lastWs = -1;
    for (let p = len - 1; p >= 0; p--) {
      if (isSpace(buffer[p])) { lastWs = p; break; }
    }
    return lastWs === -1 ? -1 : lastWs + 1;
  }

  function nextSegment(final: boolean): string | null {
    const len = buffer.length;
    if (len === 0) return null;

    let i = 0;
    while (i < len) {
      const cut = trySentenceCut(i, final);
      if (cut !== -1) {
        if (final || cut >= minSegmentLength) {
          const seg = buffer.slice(0, cut);
          buffer = buffer.slice(cut);
          return seg;
        }
        // Boundary too short mid-stream: merge forward, keep scanning past it.
        i = cut;
        continue;
      }
      i++;
    }

    if (final) {
      const seg = buffer;
      buffer = '';
      return seg;
    }

    if (len >= maxBufferLength) {
      const cut = forcedBreak();
      if (cut !== -1) {
        const seg = buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        return seg;
      }
    }
    return null;
  }

  return {
    push(text: string): string[] {
      if (text.length > 0) buffer += text;
      const out: string[] = [];
      for (;;) {
        const seg = nextSegment(false);
        if (seg === null) break;
        out.push(seg);
      }
      return out;
    },
    flush(): string[] {
      const out: string[] = [];
      for (;;) {
        const seg = nextSegment(true);
        if (seg === null) break;
        out.push(seg);
      }
      return out;
    },
    get buffered(): string {
      return buffer;
    },
  };
}
