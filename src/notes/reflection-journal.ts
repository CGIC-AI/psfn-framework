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
}

interface ReflectionJournalEntry {
  id: string;
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  channelId: string;
  mode: 'agent' | 'deliberation';
  createdAt: string;
  telemetry?: ReflectionJournalTelemetry;
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

export class ReflectionJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(input: ReflectionJournalEntryInput): ReflectionJournalEntry {
    const telemetry = normalizeReflectionTelemetry(input);
    const entry: ReflectionJournalEntry = {
      id: `reflection-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
      templateId: input.templateId.trim(),
      templateName: input.templateName.trim(),
      prompt: input.prompt.trim(),
      reflection: input.reflection.trim(),
      channelId: input.channelId.trim(),
      mode: input.mode,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(telemetry ? { telemetry } : {}),
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
