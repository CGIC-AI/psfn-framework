import { appendJsonLine } from '../persistence/jsonl.js';
import { createComponentLogger } from '../logger.js';
import { cloneInternalState, type InternalState } from '../self-model/state.js';
import type { ValuesDeliberationMetadata, ValuesMetacognitiveFlag } from '../values/store.js';

const log = createComponentLogger('ReflectionJournal');

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

function normalizeSnapshotRef(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Reflection journal internalStateSnapshotRef must be a non-empty string when provided');
  }
  return raw.trim();
}

function normalizeMetacognitiveFlags(raw: unknown): ValuesMetacognitiveFlag[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('Reflection journal metacognitiveFlags must be an array when provided');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Reflection journal metacognitiveFlags[${String(index)}] must be an object`);
    }
    const flagRaw = (entry as { flag?: unknown }).flag;
    if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
      throw new Error(`Reflection journal metacognitiveFlags[${String(index)}].flag must be a non-empty string`);
    }
    const confidenceRaw = (entry as { confidence?: unknown }).confidence;
    if (
      typeof confidenceRaw !== 'number'
      || !Number.isFinite(confidenceRaw)
      || confidenceRaw < 0
      || confidenceRaw > 1
    ) {
      throw new Error(`Reflection journal metacognitiveFlags[${String(index)}].confidence must be in [0, 1]`);
    }
    const evidenceRaw = (entry as { evidence?: unknown }).evidence;
    if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
      throw new Error(`Reflection journal metacognitiveFlags[${String(index)}].evidence must be a non-empty string`);
    }
    return {
      flag: flagRaw.trim(),
      confidence: Number(confidenceRaw.toFixed(4)),
      ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
    };
  });
}

export class ReflectionJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(input: ReflectionJournalEntryInput): ReflectionJournalEntry {
    const internalStateSnapshotRef = normalizeSnapshotRef(input.internalStateSnapshotRef);
    const internalState = input.internalState === undefined ? undefined : cloneInternalState(input.internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags(input.metacognitiveFlags);
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
