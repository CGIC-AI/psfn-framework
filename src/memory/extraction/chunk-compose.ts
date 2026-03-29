import type { SessionEntry } from '../../session/types.js';
import { isNonConversationalSessionEntry } from '../../session/manager-primitives.js';
import {
  normalizeMemoryTags,
  type ExtractedFact,
} from '../types.js';
import {
  normalizeConsentFlags,
  sensitivityOrd,
  type ConsentFlags,
  type SensitivityLevel,
} from '../../trust/types.js';

export const EXTRACTION_COMPOSITION_CHUNK_SIZE = 10;

export function isExtractionTranscriptEntry(entry: SessionEntry): boolean {
  return !isNonConversationalSessionEntry(entry)
    && (entry.role === 'assistant' || entry.role === 'user');
}

export function buildExtractionEntryChunks(
  entries: readonly SessionEntry[],
  chunkSize = EXTRACTION_COMPOSITION_CHUNK_SIZE,
): SessionEntry[][] {
  const normalizedChunkSize = Number.isFinite(chunkSize)
    ? Math.max(1, Math.floor(chunkSize))
    : EXTRACTION_COMPOSITION_CHUNK_SIZE;

  if (entries.length === 0) {
    return [[]];
  }

  const chunks: SessionEntry[][] = [];
  for (let start = 0; start < entries.length; start += normalizedChunkSize) {
    chunks.push(entries.slice(start, start + normalizedChunkSize));
  }
  return chunks;
}

export interface ExtractionTranscriptRoleNames {
  charName?: string;
  userName?: string;
}

export function formatExtractionTranscript(
  entries: readonly SessionEntry[],
  roleNames: ExtractionTranscriptRoleNames = {},
): string {
  return entries
    .filter(isExtractionTranscriptEntry)
    .map((entry) => {
      let speaker: string;
      if (entry.role === 'assistant') {
        speaker = roleNames.charName?.trim() || entry.authorName?.trim() || 'assistant';
      } else {
        speaker = entry.authorName?.trim() || roleNames.userName?.trim() || 'user';
      }
      return `${speaker}: ${entry.content}`;
    })
    .join('\n');
}

export function mergeExtractedFactGroups(
  factGroups: readonly (readonly ExtractedFact[])[],
): ExtractedFact[] {
  const mergedFacts: ExtractedFact[] = [];
  const factIndexByKey = new Map<string, number>();

  for (const group of factGroups) {
    for (const fact of group) {
      const normalized = normalizeExtractedFact(fact);
      const key = `${normalized.type}|${normalizeFactKey(normalized.text)}`;
      const existingIndex = factIndexByKey.get(key);
      if (existingIndex === undefined) {
        factIndexByKey.set(key, mergedFacts.length);
        mergedFacts.push(normalized);
        continue;
      }

      mergedFacts[existingIndex] = mergeExtractedFact(mergedFacts[existingIndex], normalized);
    }
  }

  return mergedFacts;
}

function normalizeExtractedFact(fact: ExtractedFact): ExtractedFact {
  const consentFlags = normalizeConsentFlags(fact.consentFlags);

  return {
    ...fact,
    text: fact.text.trim(),
    tags: normalizeMemoryTags(fact.tags),
    ...(Object.keys(consentFlags).length > 0 ? { consentFlags } : {}),
  };
}

function normalizeFactKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function mergeExtractedFact(existing: ExtractedFact, incoming: ExtractedFact): ExtractedFact {
  return {
    ...existing,
    importance: Math.max(existing.importance, incoming.importance),
    confidence: Math.max(existing.confidence, incoming.confidence),
    emotionalValence: selectDominantEmotionalValence(existing.emotionalValence, incoming.emotionalValence),
    tags: normalizeMemoryTags([...existing.tags, ...incoming.tags]),
    retentionClass: resolveRetentionClass(existing, incoming),
    sensitivity: resolveSensitivity(existing.sensitivity, incoming.sensitivity),
    consentFlags: resolveConsentFlags(existing.consentFlags, incoming.consentFlags),
  };
}

function selectDominantEmotionalValence(left: number, right: number): number {
  return Math.abs(right) > Math.abs(left) ? right : left;
}

function resolveRetentionClass(
  existing: ExtractedFact,
  incoming: ExtractedFact,
): ExtractedFact['retentionClass'] {
  if (existing.retentionClass === 'durable' || incoming.retentionClass === 'durable') {
    return 'durable';
  }
  return existing.retentionClass ?? incoming.retentionClass;
}

function resolveSensitivity(
  left: SensitivityLevel | undefined,
  right: SensitivityLevel | undefined,
): SensitivityLevel | undefined {
  if (!left) return right;
  if (!right) return left;
  return sensitivityOrd(left) >= sensitivityOrd(right) ? left : right;
}

function resolveConsentFlags(
  left: ConsentFlags | undefined,
  right: ConsentFlags | undefined,
): ConsentFlags | undefined {
  const merged = normalizeConsentFlags({
    ...(left ?? {}),
    ...(right ?? {}),
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}
