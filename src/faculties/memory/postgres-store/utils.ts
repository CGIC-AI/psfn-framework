import type { MemoryEvolutionRelation } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';

export function memoryKey(id1: string, id2: string): string {
  return [id1, id2].sort().join('::');
}

export function memoryEvolutionKey(
  sourceMemoryId: string,
  targetMemoryId: string,
  relation: MemoryEvolutionRelation,
): string {
  return `${sourceMemoryId}::${targetMemoryId}::${relation}`;
}

export function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function clampLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

export function lexicalScore(memory: PurrMemory, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token.length > 0);
  if (tokens.length === 0) return 0;
  const haystack = `${memory.text} ${memory.tags.join(' ')} ${memory.sourceRef}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score / tokens.length;
}
