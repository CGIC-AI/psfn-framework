import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

// ── Token Counting ──
// Uses cl100k tokenizer when available. Falls back to chars/4 on any failure.

const CHARS_PER_TOKEN_FALLBACK = 4;
const TOKENS_PER_MESSAGE_OVERHEAD = 4;
const TOKENS_PER_NAME_OVERHEAD = 1;
const TOKENS_REPLY_PRIMER = 2;

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

/**
 * Count tokens in plain text using a tokenizer (fallback: chars/4).
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  const tokenizer = getTokenizer();
  if (!tokenizer) return estimateByChars(text);

  try {
    return tokenizer.encode(text).length;
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
