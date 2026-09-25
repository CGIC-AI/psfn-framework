import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

// ── Token Counting ──
// Uses cl100k tokenizer when available. Falls back to chars/4 on any failure.

const CHARS_PER_TOKEN_FALLBACK = 4;
const TOKENS_PER_MESSAGE_OVERHEAD = 4;
const TOKENS_PER_NAME_OVERHEAD = 1;
const TOKENS_REPLY_PRIMER = 2;
// Byte-pair merging is quadratic in the length of one pre-tokenized piece, and
// the cl100k pre-tokenizer keeps a whitespace-free letter run as one piece: a
// 17,750-char runaway reply cost about 29.5 s of main-thread CPU on every turn
// that counted its history (psfn-framework-jrki1). Runs longer than this are
// encoded in slices of this many UTF-16 units, so the cost is linear
// (measured sweet spot: ~0.02 ms per char). Ordinary prose never has a run
// this long and is encoded exactly as before.
const BPE_RUN_SLICE_UNITS = 128;
const LONG_RUN_PATTERN = new RegExp(`\\s?\\S{${BPE_RUN_SLICE_UNITS + 1},}`, 'gu');

interface TokenizerLike {
  encode(text: string): { length: number };
}

export interface TokenCountMessage {
  role: string;
  content: string;
  name?: string;
}

let tokenizerFactory: () => TokenizerLike = () => new Tiktoken(cl100kBase);
let cachedTokenizer: TokenizerLike | null = null;
let tokenizerUnavailable = false;

function estimateByChars(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
}

function getTokenizer(): TokenizerLike | null {
  if (cachedTokenizer) return cachedTokenizer;
  if (tokenizerUnavailable) return null;

  try {
    cachedTokenizer = tokenizerFactory();
    return cachedTokenizer;
  } catch {
    tokenizerUnavailable = true;
    return null;
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Encode one long run in slices, never splitting a surrogate pair. */
function encodeRunLength(tokenizer: TokenizerLike, run: string): number {
  let total = 0;
  let start = 0;
  while (start < run.length) {
    let end = Math.min(start + BPE_RUN_SLICE_UNITS, run.length);
    if (end < run.length && isLowSurrogate(run.charCodeAt(end))) end += 1;
    total += tokenizer.encode(run.slice(start, end)).length;
    start = end;
  }
  return total;
}

/**
 * Token length of `text`, encoding whitespace-free runs longer than
 * BPE_RUN_SLICE_UNITS in slices (a slice boundary may differ from the exact
 * count by about one token) and everything else unchanged.
 */
function encodeLengthWithBoundedRuns(tokenizer: TokenizerLike, text: string): number {
  if (text.length <= BPE_RUN_SLICE_UNITS) return tokenizer.encode(text).length;
  let total = 0;
  let cursor = 0;
  for (const match of text.matchAll(LONG_RUN_PATTERN)) {
    const runStart = match.index;
    if (runStart > cursor) total += tokenizer.encode(text.slice(cursor, runStart)).length;
    total += encodeRunLength(tokenizer, match[0]);
    cursor = runStart + match[0].length;
  }
  if (cursor === 0) return tokenizer.encode(text).length;
  if (cursor < text.length) total += tokenizer.encode(text.slice(cursor)).length;
  return total;
}

/**
 * Count tokens in plain text using a tokenizer (fallback: chars/4).
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  const tokenizer = getTokenizer();
  if (!tokenizer) return estimateByChars(text);

  try {
    return encodeLengthWithBoundedRuns(tokenizer, text);
  } catch {
    tokenizerUnavailable = true;
    cachedTokenizer = null;
    return estimateByChars(text);
  }
}

/**
 * Count chat message tokens including framing overhead.
 */
export function countMessageTokens(messages: readonly TokenCountMessage[]): number {
  if (messages.length === 0) return 0;

  let total = TOKENS_REPLY_PRIMER;
  for (const message of messages) {
    total += TOKENS_PER_MESSAGE_OVERHEAD;
    total += countTokens(message.role);
    total += countTokens(message.content);
    if (message.name) {
      total += TOKENS_PER_NAME_OVERHEAD;
      total += countTokens(message.name);
    }
  }

  return total;
}

/**
 * Compatibility alias for legacy callsites.
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Human-readable token display.
 * Examples: 980 -> "980", 1_200 -> "1.2k", 2_300_000 -> "2.3M".
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const __test = {
  resetTokenizerState(): void {
    cachedTokenizer = null;
    tokenizerUnavailable = false;
    tokenizerFactory = () => new Tiktoken(cl100kBase);
  },
  setTokenizerFactory(factory: () => TokenizerLike): void {
    tokenizerFactory = factory;
    cachedTokenizer = null;
    tokenizerUnavailable = false;
  },
};
