import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

// ── Token Counting ──
// Uses cl100k tokenizer when available. Falls back to chars/4 on any failure.

const CHARS_PER_TOKEN_FALLBACK = 4;
const TOKENS_PER_MESSAGE_OVERHEAD = 4;
const TOKENS_PER_NAME_OVERHEAD = 1;
const TOKENS_REPLY_PRIMER = 2;
// Byte-pair merging is quadratic in the length of one pre-tokenized piece, and
// the cl100k pre-tokenizer keeps a letter run as one piece: a 17,750-char
// runaway reply cost about 29.5 s of main-thread CPU on every turn that
// counted its history (psfn-framework-jrki1). Pieces longer than this are
// encoded in slices of this many UTF-16 units, so the cost is linear
// (measured sweet spot: ~0.02 ms per char). Text is only ever split at the
// tokenizer's own piece boundaries, so any text without such a piece (prose,
// code, JSON) counts exactly as an unsplit encode.
const BPE_RUN_SLICE_UNITS = 128;
const PRETOKENIZER_PATTERN = new RegExp(cl100kBase.pat_str, 'gu');
// History is recounted every turn (psfn-framework-z9rkr): counts of texts at
// least this long are memoized by content hash, process-wide, evicting the
// least recently used beyond the bound (a memory guard, not a tuning knob).
const TOKEN_COUNT_CACHE_MIN_TEXT_UNITS = 256;
const TOKEN_COUNT_CACHE_MAX_ENTRIES = 4096;

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
const tokenCountCache = new Map<string, number>();

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
 * Token length of `text`. Text between pre-tokenizer pieces longer than
 * BPE_RUN_SLICE_UNITS is encoded unchanged; each such piece is encoded in
 * slices (a slice boundary may differ from the exact count by about one
 * token).
 */
function encodeLengthWithBoundedPieces(tokenizer: TokenizerLike, text: string): number {
  if (text.length <= BPE_RUN_SLICE_UNITS) return tokenizer.encode(text).length;
  let total = 0;
  let cursor = 0;
  for (const match of text.matchAll(PRETOKENIZER_PATTERN)) {
    if (match[0].length <= BPE_RUN_SLICE_UNITS) continue;
    const pieceStart = match.index;
    if (pieceStart > cursor) total += tokenizer.encode(text.slice(cursor, pieceStart)).length;
    total += encodeRunLength(tokenizer, match[0]);
    cursor = pieceStart + match[0].length;
  }
  if (cursor === 0) return tokenizer.encode(text).length;
  if (cursor < text.length) total += tokenizer.encode(text.slice(cursor)).length;
  return total;
}

function countWithCache(tokenizer: TokenizerLike, text: string): number {
  if (text.length < TOKEN_COUNT_CACHE_MIN_TEXT_UNITS) return encodeLengthWithBoundedPieces(tokenizer, text);
  const key = createHash('sha256').update(text).digest('base64');
  const cached = tokenCountCache.get(key);
  if (cached !== undefined) {
    // Refresh recency: Map iteration order is insertion order.
    tokenCountCache.delete(key);
    tokenCountCache.set(key, cached);
    return cached;
  }
  const count = encodeLengthWithBoundedPieces(tokenizer, text);
  tokenCountCache.set(key, count);
  if (tokenCountCache.size > TOKEN_COUNT_CACHE_MAX_ENTRIES) {
    const oldest = tokenCountCache.keys().next();
    if (!oldest.done) tokenCountCache.delete(oldest.value);
  }
  return count;
}

/**
 * Count tokens in plain text using a tokenizer (fallback: chars/4).
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  const tokenizer = getTokenizer();
  if (!tokenizer) return estimateByChars(text);

  try {
    return countWithCache(tokenizer, text);
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
  tokenCountCacheSize(): number {
    return tokenCountCache.size;
  },
  tokenCountCacheBound(): number {
    return TOKEN_COUNT_CACHE_MAX_ENTRIES;
  },
  resetTokenizerState(): void {
    tokenCountCache.clear();
    cachedTokenizer = null;
    tokenizerUnavailable = false;
    tokenizerFactory = () => new Tiktoken(cl100kBase);
  },
  setTokenizerFactory(factory: () => TokenizerLike): void {
    tokenCountCache.clear();
    tokenizerFactory = factory;
    cachedTokenizer = null;
    tokenizerUnavailable = false;
  },
};
