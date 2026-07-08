import { appendJsonLine, readJsonLines } from '../jsonl.js';
import { createComponentLogger } from '../../shared/logger.js';
import { cloneInternalState, type InternalState } from '../../core/self-model/state.js';
import type { ValuesMetacognitiveFlag } from '../../faculties/values/narrative-context-types.js';
import {
  normalizeNarrativeMetacognitiveFlags,
  normalizeNarrativeSnapshotRef,
} from '../../faculties/values/narrative-context-normalization.js';
import type { ValuesDeliberationMetadata } from '../../faculties/values/store.js';

const log = createComponentLogger('ReflectionJournal');
const REFLECTION_JOURNAL_ERROR_PREFIX = 'Reflection journal';

export const NON_CANONICAL_REFLECTION_SUBSTRATE = 'non_canonical_reflection_substrate' as const;

function normalizeTemplateId(templateId: string): string {
  const normalized = templateId.trim();
  return /^whisper$/i.test(normalized) ? 'musing' : normalized;
}

function normalizeTemplateName(templateName: string): string {
  const normalized = templateName.trim();
  return /^whisper$/i.test(normalized) ? 'Musing' : normalized;
}

interface ReflectionJournalNarrativeContext {
  internalStateSnapshotRef: string;
  internalState: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
}

export interface ReflectionJournalTelemetry {
  deliberation?: ValuesDeliberationMetadata;
  narrativeContext?: ReflectionJournalNarrativeContext;
}

export interface ReflectionJournalEntryInput {
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  channelId: string;
  mode: 'agent' | 'deliberation';
  createdAt?: string;
  telemetry?: ReflectionJournalTelemetry;
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  substrateBoundary?: string;
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
  telemetry?: ReflectionJournalTelemetry;
  substrateBoundary?: string;
  substrateProvenanceRefs?: string[];
}

export interface ReflectionJournalListOptions {
  limit?: number;
}

function normalizeReflectionTelemetry(
  input: ReflectionJournalEntryInput,
): ReflectionJournalTelemetry | undefined {
  const telemetryInput = input.telemetry;
  const deliberation = telemetryInput?.deliberation ?? input.deliberation;

  const narrativeInput = telemetryInput?.narrativeContext
    ?? ((input.internalStateSnapshotRef !== undefined
      || input.internalState !== undefined
      || input.metacognitiveFlags !== undefined)
      ? {
          internalStateSnapshotRef: input.internalStateSnapshotRef,
          internalState: input.internalState,
          metacognitiveFlags: input.metacognitiveFlags,
        }
      : undefined);

  if (!narrativeInput && !deliberation) {
    return undefined;
  }

  let narrativeContext: ReflectionJournalNarrativeContext | undefined;
  if (narrativeInput) {
    const internalStateSnapshotRef = normalizeNarrativeSnapshotRef(
      narrativeInput.internalStateSnapshotRef,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    const internalState = narrativeInput.internalState === undefined
      ? undefined
      : cloneInternalState(narrativeInput.internalState);
    const metacognitiveFlags = normalizeNarrativeMetacognitiveFlags(
      narrativeInput.metacognitiveFlags,
      { contextPrefix: REFLECTION_JOURNAL_ERROR_PREFIX },
    );
    if ((internalStateSnapshotRef || internalState || metacognitiveFlags) && (!internalStateSnapshotRef || !internalState)) {
      throw new Error(
        'Reflection journal entry requires both internalStateSnapshotRef and internalState when narrative context is provided',
      );
    }

    if (internalStateSnapshotRef && internalState) {
      narrativeContext = {
        internalStateSnapshotRef,
        internalState,
        ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
      };
    }
  }

  if (!narrativeContext && !deliberation) {
    return undefined;
  }

  return {
    ...(deliberation ? { deliberation } : {}),
    ...(narrativeContext ? { narrativeContext } : {}),
  };
}

function normalizeProvenanceRefs(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Reflection journal substrateProvenanceRefs must be an array when provided');
  }
  const normalized = [...new Set(value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`Reflection journal substrateProvenanceRefs[${String(index)}] must be a non-empty string`);
    }
    return entry.trim();
  }))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePersistedReflectionEntry(raw: unknown): ReflectionJournalEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const entry = raw as Partial<ReflectionJournalEntry>;
  if (
    typeof entry.id !== 'string'
    || typeof entry.templateId !== 'string'
    || typeof entry.templateName !== 'string'
    || typeof entry.prompt !== 'string'
    || typeof entry.reflection !== 'string'
    || typeof entry.channelId !== 'string'
    || typeof entry.createdAt !== 'string'
    || (entry.mode !== 'agent' && entry.mode !== 'deliberation')
  ) {
    return null;
  }

  try {
    const substrateProvenanceRefs = normalizeProvenanceRefs(entry.substrateProvenanceRefs);
    return {
      id: entry.id.trim(),
      templateId: normalizeTemplateId(entry.templateId),
      templateName: normalizeTemplateName(entry.templateName),
      prompt: entry.prompt.trim(),
      reflection: entry.reflection.trim(),
      channelId: entry.channelId.trim(),
      mode: entry.mode,
      createdAt: entry.createdAt.trim(),
      ...(entry.telemetry ? { telemetry: entry.telemetry } : {}),
      ...(typeof entry.substrateBoundary === 'string' && entry.substrateBoundary.trim().length > 0
        ? { substrateBoundary: entry.substrateBoundary.trim() }
        : {}),
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
    const telemetry = normalizeReflectionTelemetry(input);
    const substrateBoundary = input.substrateBoundary?.trim();
    const substrateProvenanceRefs = normalizeProvenanceRefs(input.substrateProvenanceRefs);
    const entry: ReflectionJournalEntry = {
      id: `reflection-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
      templateId: normalizeTemplateId(input.templateId),
      templateName: normalizeTemplateName(input.templateName),
      prompt: input.prompt.trim(),
      reflection: input.reflection.trim(),
      channelId: input.channelId.trim(),
      mode: input.mode,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(telemetry ? { telemetry } : {}),
      ...(substrateBoundary ? { substrateBoundary } : {}),
      ...(substrateProvenanceRefs ? { substrateProvenanceRefs } : {}),
    };

    if (!entry.templateId || !entry.templateName || !entry.prompt || !entry.channelId) {
      throw new Error('Reflection journal entry requires templateId, templateName, prompt, and channelId');
    }

    appendJsonLine(this.filePath, entry);
    log.debug('Persisted reflection journal entry', {
      templateId: entry.templateId,
      mode: entry.mode,
      channelId: entry.channelId,
    });
    return entry;
  }

  listRecent(options: ReflectionJournalListOptions = {}): ReflectionJournalEntry[] {
    const limitRaw = options.limit ?? 10;
    if (!Number.isInteger(limitRaw) || limitRaw < 1) {
      throw new Error('Reflection journal listRecent limit must be a positive integer when provided');
    }
    return readJsonLines(this.filePath, normalizePersistedReflectionEntry).entries
      .sort((left, right) => {
        const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (createdAtDelta !== 0) {
          return createdAtDelta;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(0, limitRaw);
  }
}
