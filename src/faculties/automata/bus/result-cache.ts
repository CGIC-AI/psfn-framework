import type { AppCache } from '../../../shared/cache/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  AutomataBusResultCachePort,
  AutomataBusScoredReference,
} from './query-ports.js';

function parseOptionalScore(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`cached Automata Bus ${field} must be a finite number in [0,1]`);
  }
  return value;
}

function parseReference(value: unknown): AutomataBusScoredReference {
  if (!isRecord(value)) throw new Error('cached Automata Bus reference must be an object');
  const unknown = Object.keys(value)
    .filter(key => key !== 'eventId' && key !== 'semanticScore' && key !== 'lexicalScore');
  if (unknown.length > 0) {
    throw new Error(`cached Automata Bus reference contains unknown fields: ${unknown.sort().join(', ')}`);
  }
  if (typeof value.eventId !== 'string' || value.eventId.trim().length === 0) {
    throw new Error('cached Automata Bus eventId must be non-empty');
  }
  const semanticScore = parseOptionalScore(value.semanticScore, 'semanticScore');
  const lexicalScore = parseOptionalScore(value.lexicalScore, 'lexicalScore');
  if (semanticScore === undefined && lexicalScore === undefined) {
    throw new Error('cached Automata Bus reference must include a score');
  }
  return {
    eventId: value.eventId.trim(),
    ...(semanticScore !== undefined ? { semanticScore } : {}),
    ...(lexicalScore !== undefined ? { lexicalScore } : {}),
  };
}

export function createAutomataBusResultCache(cache: AppCache): AutomataBusResultCachePort {
  return {
    async get(key) {
      const encoded = await cache.get(key);
      if (encoded === null) return null;
      const parsed: unknown = JSON.parse(encoded);
      if (!Array.isArray(parsed)) throw new Error('cached Automata Bus result must be an array');
      return parsed.map(parseReference);
    },
    async set(key, references, ttlMs) {
      await cache.set(key, JSON.stringify(references), { ttlMs });
    },
  };
}
