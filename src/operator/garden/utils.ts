import type { CharacterCardV2 } from '../../core/identity/types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  type MemoryType,
  type SensitivityLevel,
} from '../../faculties/memory/types.js';
import {
  VALID_RELATIONSHIP_TYPES,
  type RelationshipType,
} from '../../core/contacts/types.js';
import type { AdminChatDebugDetailValue } from './types.js';

const RELATIONSHIP_TYPE_HINTS: ReadonlyArray<{ type: RelationshipType; hints: readonly string[] }> = [
  { type: 'partner', hints: ['partner', 'spouse', 'wife', 'husband', 'boyfriend', 'girlfriend'] },
  { type: 'family', hints: ['family', 'mother', 'father', 'sister', 'brother', 'parent', 'child'] },
  { type: 'friend', hints: ['friend', 'bestie', 'buddy'] },
  { type: 'acquaintance', hints: ['acquaintance', 'coworker', 'colleague', 'neighbor'] },
  { type: 'ai_companion', hints: ['ai_companion', 'companion'] },
];

const RELATIONSHIP_STRENGTH: Record<RelationshipType, number> = {
  stranger: 0,
  acquaintance: 1,
  friend: 2,
  family: 3,
  ai_companion: 3,
  partner: 4,
};

export function truncateDebugText(value: unknown, maxChars = 280): string {
  if (typeof value !== 'string') return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

export function toDebugDetailValue(value: unknown): AdminChatDebugDetailValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return truncateDebugText(value, 160);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (value instanceof Error) return truncateDebugText(value.message, 160);
  if (Array.isArray(value)) return `[${value.length} items]`;
  return undefined;
}

export function clampUnit(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeSessionRole(value: unknown): 'user' | 'assistant' | 'system' {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'assistant' || text === 'bot' || text === 'ai' || text === 'character' || text === 'char') {
    return 'assistant';
  }
  if (text === 'system') return 'system';
  return 'user';
}

export function normalizeSensitivity(value: unknown): SensitivityLevel {
  if (typeof value !== 'string') return 'personal';
  const normalized = value.trim().toLowerCase();
  return VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)
    ? normalized as SensitivityLevel
    : 'personal';
}

export function estimateTokens(text: string): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsedNumber = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsedNumber) && parsedNumber > 0) return parsedNumber;
      const parsedDate = Date.parse(trimmed);
      if (Number.isFinite(parsedDate) && parsedDate > 0) return parsedDate;
    }
  }
  return fallback;
}

export function uniqueLowercase(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) out.add(normalized);
  }
  return [...out];
}

export function normalizeProvenanceRefs(values: readonly string[], fallback?: string): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const normalized = raw.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  const normalizedFallback = fallback?.trim();
  if (normalizedFallback && normalizedFallback.length > 0) {
    out.add(normalizedFallback);
  }
  return [...out];
}

export function parseProvenanceRefs(entry: Record<string, unknown>, fallbackRef: string): string[] {
  const refs = [
    ...toStringArray(entry.provenanceRefs),
    ...toStringArray(entry.provenance),
    ...toStringArray(entry.sources),
  ];
  const source = toNonEmptyString(entry.sourceRef)
    ?? toNonEmptyString(entry.source)
    ?? toNonEmptyString(entry.origin);
  if (source) refs.push(source);
  return normalizeProvenanceRefs(refs, fallbackRef);
}

export function buildMemoryDedupKey(text: string, type: MemoryType, contactId?: string): string {
  const normalizedText = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const normalizedContact = contactId?.trim().toLowerCase() ?? '';
  return `${type}|${normalizedContact}|${normalizedText}`;
}

export function inferRelationshipTypeHint(input: {
  explicitValue?: unknown;
  text: string;
  tags: readonly string[];
  type: MemoryType;
}): RelationshipType | undefined {
  const explicit = toNonEmptyString(input.explicitValue)?.toLowerCase();
  if (explicit && VALID_RELATIONSHIP_TYPES.includes(explicit as RelationshipType)) {
    return explicit as RelationshipType;
  }
  if (input.type !== 'relational') return undefined;

  const corpus = `${input.text.toLowerCase()} ${input.tags.join(' ')}`;
  for (const entry of RELATIONSHIP_TYPE_HINTS) {
    if (entry.hints.some(hint => corpus.includes(hint))) {
      return entry.type;
    }
  }
  return undefined;
}

export function shouldPromoteRelationship(existing: RelationshipType, candidate: RelationshipType): boolean {
  return RELATIONSHIP_STRENGTH[candidate] > RELATIONSHIP_STRENGTH[existing];
}

export function normalizeCardFieldValue(card: CharacterCardV2, key: keyof CharacterCardV2['data']): string {
  if (key === 'tags') return card.data.tags.join(', ');
  const value = card.data[key];
  return typeof value === 'string' ? value : '';
}

export function isMemoryType(value: string): value is MemoryType {
  return VALID_MEMORY_TYPES.includes(value as MemoryType);
}
