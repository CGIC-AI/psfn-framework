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
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
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
    const entry: ReflectionJournalEntry = {
      id: `reflection-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
      templateId: input.templateId.trim(),
      templateName: input.templateName.trim(),
      prompt: input.prompt.trim(),
      reflection: input.reflection.trim(),
      channelId: input.channelId.trim(),
      mode: input.mode,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.deliberation ? { deliberation: input.deliberation } : {}),
      ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      ...(internalState ? { internalState } : {}),
      ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
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
