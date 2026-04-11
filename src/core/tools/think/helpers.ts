// ── REPL Text Analysis Helpers ──
// Pure utility functions injected into the RLM sandbox.
// No external dependencies — all logic is self-contained.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'while', 'how', 'what', 'which', 'who', 'whom', 'where',
  'why', 'that', 'this', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
  'them', 'their',
]);

function tryRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

// ── Text Search ──

/** Regex search with context lines (like grep -C). Returns array of match-with-context blocks. */
export function search(text: string, pattern: string, contextLines = 0): string[] {
  const re = tryRegex(pattern);
  if (!re) return [];

  const lines = text.split('\n');
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) matchIndices.push(i);
  }

  if (matchIndices.length === 0) return [];

  const blocks: string[] = [];
  for (const idx of matchIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    blocks.push(lines.slice(start, end + 1).join('\n'));
  }
  return blocks;
}

/** Line filtering — return matching lines joined by newline. */
export function grep(text: string, pattern: string): string {
  const re = tryRegex(pattern);
  if (!re) return '';
  return text.split('\n').filter(line => re.test(line)).join('\n');
}

/** Inverse grep — return non-matching lines. */
export function grep_v(text: string, pattern: string): string {
  const re = tryRegex(pattern);
  if (!re) return '';
  return text.split('\n').filter(line => !re.test(line)).join('\n');
}

// ── Text Extraction ──

/** Extract text between start and end markers (first occurrence). Returns '' if not found. */
export function between(text: string, start: string, end: string): string {
  const startIdx = text.indexOf(start);
  if (startIdx === -1) return '';
  const afterStart = startIdx + start.length;
  const endIdx = text.indexOf(end, afterStart);
  if (endIdx === -1) return '';
  return text.slice(afterStart, endIdx);
}

/** First N lines (default 10). */
export function head(text: string, n = 10): string {
  return text.split('\n').slice(0, n).join('\n');
}

/** Last N lines (default 10). */
export function tail(text: string, n = 10): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// ── Analysis ──

/** Word frequency map. Lowercased, skipping stopwords. */
export function word_frequency(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const words = text.toLowerCase().match(/[a-z]+/g);
  if (!words) return counts;
  for (const w of words) {
    if (!STOPWORDS.has(w)) {
      counts[w] = (counts[w] || 0) + 1;
    }
  }
  return counts;
}

/** Simple line diff. Returns "+added" / "-removed" lines. */
export function diff(a: string, b: string): string {
  const aLines = new Set(a.split('\n'));
  const bLines = new Set(b.split('\n'));
  const result: string[] = [];

  for (const line of aLines) {
    if (!bLines.has(line)) result.push(`-${line}`);
  }
  for (const line of bLines) {
    if (!aLines.has(line)) result.push(`+${line}`);
  }
  return result.join('\n');
}

/** Jaccard similarity between two texts (word-level, 0-1). Returns 0 for empty inputs. */
export function text_similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().match(/[a-z]+/g) || []);
  const wordsB = new Set(b.toLowerCase().match(/[a-z]+/g) || []);
  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// ── Collections ──

/** Deduplicate array by key function. Keeps first occurrence. */
export function dedupe<T>(arr: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return result;
}

/** Group array by key function. */
export function group_by<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (groups[k] ??= []).push(item);
  }
  return groups;
}

/** Partition array by predicate into [truthy, falsy]. */
export function partition<T>(arr: T[], pred: (item: T) => boolean): [T[], T[]] {
  const truthy: T[] = [];
  const falsy: T[] = [];
  for (const item of arr) {
    if (pred(item)) truthy.push(item);
    else falsy.push(item);
  }
  return [truthy, falsy];
}
