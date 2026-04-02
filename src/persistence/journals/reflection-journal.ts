import { appendJsonLine } from '../jsonl.js';
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
}
