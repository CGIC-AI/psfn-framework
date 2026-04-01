import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../persistence/jsonl.js';
import { createComponentLogger } from '../logger.js';
import { cloneInternalState, type InternalState } from '../self-model/state.js';
import type { ValuesMetacognitiveFlag } from '../values/narrative-context-types.js';
import {
  normalizeNarrativeMetacognitiveFlags,
  normalizeNarrativeSnapshotRef,
} from '../values/narrative-context-normalization.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';

const log = createComponentLogger('ReflectionJournal');
const REFLECTION_JOURNAL_ERROR_PREFIX = 'Reflection journal';
export const NON_CANONICAL_REFLECTION_SUBSTRATE = 'non_canonical_reflection_substrate' as const;

export interface ReflectionJournalListOptions {
  limit?: number;
}

export interface ReflectionJournalEntryInput {
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  channelId: string;
  mode: 'agent' | 'deliberation';
  createdAt?: string;
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  substrateBoundary?: typeof NON_CANONICAL_REFLECTION_SUBSTRATE;
  substrateProvenanceRefs?: string[];
}

export interface ReflectionJournalEntry {
  id: string;
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  channelId: string;
  mode: 'agent' | 'deliberation';
  createdAt: string;
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  substrateBoundary?: typeof NON_CANONICAL_REFLECTION_SUBSTRATE;
  substrateProvenanceRefs?: string[];
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeNonEmptyString(value, fieldName);
}

function normalizeSubstrateBoundary(
  value: unknown,
): typeof NON_CANONICAL_REFLECTION_SUBSTRATE | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== NON_CANONICAL_REFLECTION_SUBSTRATE) {
    throw new Error(
      `Reflection journal substrateBoundary must be "${NON_CANONICAL_REFLECTION_SUBSTRATE}" when provided`,
    );
  }
  return value;
}

function normalizeProvenanceRefs(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Reflection journal substrateProvenanceRefs must be an array when provided');
  }
  const refs = [...new Set(value.map((ref, index) => normalizeNonEmptyString(ref, `substrateProvenanceRefs[${String(index)}]`)))];
  return refs.length > 0 ? refs : undefined;
}

function normalizeEntry(
  raw: unknown,
): ReflectionJournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ReflectionJournalEntry>;
  if (
    typeof entry.id !== 'string'
    || entry.id.trim().length === 0
    || typeof entry.templateId !== 'string'
    || entry.templateId.trim().length === 0
    || typeof entry.templateName !== 'string'
    || entry.templateName.trim().length === 0
    || typeof entry.prompt !== 'string'
    || entry.prompt.trim().length === 0
    || typeof entry.reflection !== 'string'
    || entry.reflection.trim().length === 0
    || typeof entry.channelId !== 'string'
    || entry.channelId.trim().length === 0
    || (entry.mode !== 'agent' && entry.mode !== 'deliberation')
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
  ) {
    return null;
  }

  try {
    const internalStateSnapshotRef = normalizeNarrativeSnapshotRef(
      (entry as { internalStateSnapshotRef?: unknown }).internalStateSnapshotRef,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    const internalState = entry.internalState === undefined ? undefined : cloneInternalState(entry.internalState);
    const metacognitiveFlags = normalizeNarrativeMetacognitiveFlags(
      (entry as { metacognitiveFlags?: unknown }).metacognitiveFlags,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    if ((internalStateSnapshotRef || internalState || metacognitiveFlags) && (!internalStateSnapshotRef || !internalState)) {
      return null;
    }

    const substrateBoundary = normalizeSubstrateBoundary((entry as { substrateBoundary?: unknown }).substrateBoundary);
    const substrateProvenanceRefs = normalizeProvenanceRefs(
      (entry as { substrateProvenanceRefs?: unknown }).substrateProvenanceRefs,
    );
    if ((substrateBoundary || substrateProvenanceRefs) && (!substrateBoundary || !substrateProvenanceRefs)) {
      return null;
    }

    return {
      id: entry.id.trim(),
      templateId: entry.templateId.trim(),
      templateName: entry.templateName.trim(),
      prompt: entry.prompt.trim(),
      reflection: entry.reflection.trim(),
      channelId: entry.channelId.trim(),
      mode: entry.mode,
      createdAt: entry.createdAt.trim(),
      ...(entry.deliberation ? { deliberation: entry.deliberation } : {}),
      ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      ...(internalState ? { internalState } : {}),
      ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
      ...(substrateBoundary ? { substrateBoundary } : {}),
      ...(substrateProvenanceRefs ? { substrateProvenanceRefs } : {}),
    };
  } catch {
    return null;
  }
}

export class ReflectionJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(input: ReflectionJournalEntryInput): ReflectionJournalEntry {
    const internalStateSnapshotRef = normalizeNarrativeSnapshotRef(
      input.internalStateSnapshotRef,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    const internalState = input.internalState === undefined ? undefined : cloneInternalState(input.internalState);
    const metacognitiveFlags = normalizeNarrativeMetacognitiveFlags(
      input.metacognitiveFlags,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    if ((internalStateSnapshotRef || internalState || metacognitiveFlags) && (!internalStateSnapshotRef || !internalState)) {
      throw new Error(
        'Reflection journal entry requires both internalStateSnapshotRef and internalState when narrative context is provided',
      );
    }
    const substrateBoundary = normalizeSubstrateBoundary(input.substrateBoundary);
    const substrateProvenanceRefs = normalizeProvenanceRefs(input.substrateProvenanceRefs);
    if ((substrateBoundary || substrateProvenanceRefs) && (!substrateBoundary || !substrateProvenanceRefs)) {
      throw new Error(
        'Reflection journal entry requires both substrateBoundary and substrateProvenanceRefs when reflection substrate context is provided',
      );
    }
    const entry: ReflectionJournalEntry = {
      id: `reflection-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
      templateId: normalizeNonEmptyString(input.templateId, 'templateId'),
      templateName: normalizeNonEmptyString(input.templateName, 'templateName'),
      prompt: normalizeNonEmptyString(input.prompt, 'prompt'),
      reflection: normalizeNonEmptyString(input.reflection, 'reflection'),
      channelId: normalizeNonEmptyString(input.channelId, 'channelId'),
      mode: input.mode,
      createdAt: normalizeOptionalString(input.createdAt, 'createdAt') ?? new Date().toISOString(),
      ...(input.deliberation ? { deliberation: input.deliberation } : {}),
      ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      ...(internalState ? { internalState } : {}),
      ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
      ...(substrateBoundary ? { substrateBoundary } : {}),
      ...(substrateProvenanceRefs ? { substrateProvenanceRefs } : {}),
    };

    appendJsonLine(this.filePath, entry);
    log.debug('Persisted reflection journal entry', {
      templateId: entry.templateId,
      mode: entry.mode,
      channelId: entry.channelId,
    });
    return entry;
  }

  listRecent(options: ReflectionJournalListOptions = {}): ReflectionJournalEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf-8');
    if (raw.trim().length === 0) return [];

    const entries = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map((line, index) => {
        try {
          return normalizeEntry(JSON.parse(line) as unknown);
        } catch (error) {
          log.warn('Skipping unreadable reflection journal line', {
            line: index + 1,
            error: String(error),
          });
          return null;
        }
      })
      .filter((entry): entry is ReflectionJournalEntry => entry !== null)
      .sort((left, right) => {
        const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (timeDelta !== 0) return timeDelta;
        return right.id.localeCompare(left.id);
      });

    if (options.limit === undefined || options.limit < 1) {
      return entries;
    }
    return entries.slice(0, options.limit);
  }
}
