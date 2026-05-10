import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../jsonl.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ValuesMetacognitiveFlag } from '../../faculties/values/narrative-context-types.js';
import {
  normalizeNarrativeMetacognitiveFlags,
  normalizeNarrativeSnapshotRef,
} from '../../faculties/values/narrative-context-normalization.js';
import {
  normalizeValuesDeliberationMetadata,
  type ValuesDeliberationMetadata,
} from '../../faculties/values/store.js';
import type { ReflectionExecutionSource } from './reflection-substrate.js';

const log = createComponentLogger('ReflectionMetacognitionJournal');
const ERROR_PREFIX = 'Reflection metacognition journal';

export type ReflectionMetacognitionEntryKind = 'reflection_run' | 'reflection_mutation';

type JsonPrimitive = string | number | boolean | null;
export type ReflectionMutationSnapshot = JsonPrimitive | ReflectionMutationSnapshot[] | {
  [key: string]: ReflectionMutationSnapshot;
};

export interface ReflectionMetacognitionMirrorStore {
  mirrorEntry(entry: ReflectionMetacognitionJournalEntry): Promise<void>;
}

export interface ReflectionMetacognitionJournalListOptions {
  limit?: number;
}

interface ReflectionMetacognitionEntryBaseInput {
  occurredAt?: string;
  initiatorSurface: string;
  initiatedBy: string;
  reason?: string;
  templateId?: string;
  templateName?: string;
  executionSource?: ReflectionExecutionSource;
  channelId?: string;
  sendToDiscordEffective?: boolean;
  mode?: 'agent' | 'deliberation';
  internalStateSnapshotRef?: string;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  reflectionJournalEntryId?: string;
  dailyJournalEntryId?: string;
  processId?: string;
  prompt?: string;
  reflection?: string;
  deliberation?: ValuesDeliberationMetadata;
  substrateBoundary?: string;
  substrateProvenanceRefs?: string[];
}

export interface ReflectionRunMetacognitionEntryInput extends ReflectionMetacognitionEntryBaseInput {
  kind: 'reflection_run';
  templateId: string;
  templateName: string;
  executionSource: ReflectionExecutionSource;
  channelId: string;
  sendToDiscordEffective: boolean;
  mode: 'agent' | 'deliberation';
  prompt: string;
  reflection: string;
}

export interface ReflectionMutationMetacognitionEntryInput extends ReflectionMetacognitionEntryBaseInput {
  kind: 'reflection_mutation';
  mutationBefore?: ReflectionMutationSnapshot;
  mutationAfter?: ReflectionMutationSnapshot;
}

export type ReflectionMetacognitionJournalEntryInput =
  | ReflectionRunMetacognitionEntryInput
  | ReflectionMutationMetacognitionEntryInput;

export interface ReflectionMetacognitionJournalEntry {
  id: string;
  kind: ReflectionMetacognitionEntryKind;
  occurredAt: string;
  initiatorSurface: string;
  initiatedBy: string;
  reason?: string;
  templateId?: string;
  templateName?: string;
  executionSource?: ReflectionExecutionSource;
  channelId?: string;
  sendToDiscordEffective?: boolean;
  mode?: 'agent' | 'deliberation';
  internalStateSnapshotRef?: string;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  reflectionJournalEntryId?: string;
  dailyJournalEntryId?: string;
  processId?: string;
  mutationBefore?: ReflectionMutationSnapshot;
  mutationAfter?: ReflectionMutationSnapshot;
  prompt?: string;
  reflection?: string;
  deliberation?: ValuesDeliberationMetadata;
  substrateBoundary?: string;
  substrateProvenanceRefs?: string[];
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeRequiredString(value, fieldName);
}

function normalizeOccurredAt(value: unknown, now: () => number): string {
  if (value === undefined || value === null) {
    return new Date(now()).toISOString();
  }
  const occurredAt = normalizeRequiredString(value, 'occurredAt');
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error('occurredAt must be an ISO-8601 timestamp');
  }
  return occurredAt;
}

function normalizeRequiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function cloneMutationSnapshot(value: unknown, fieldName: string): ReflectionMutationSnapshot {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName} must not contain non-finite numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneMutationSnapshot(entry, `${fieldName}[${String(index)}]`));
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${fieldName} must be JSON-serializable`);
  }
  const cloned: Record<string, ReflectionMutationSnapshot> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    cloned[key] = cloneMutationSnapshot(child, `${fieldName}.${key}`);
  }
  return cloned;
}

function normalizeMutationSnapshot(
  value: unknown,
  fieldName: string,
): ReflectionMutationSnapshot | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return cloneMutationSnapshot(value, fieldName);
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array when provided`);
  }
  const normalized = [...new Set(value.map((entry, index) => normalizeRequiredString(entry, `${fieldName}[${String(index)}]`)))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBaseEntry(
  input: ReflectionMetacognitionEntryBaseInput,
  now: () => number,
): Omit<ReflectionMetacognitionJournalEntry, 'id' | 'kind'> {
  const internalStateSnapshotRef = normalizeNarrativeSnapshotRef(
    input.internalStateSnapshotRef,
    { contextPrefix: ERROR_PREFIX },
  );
  const metacognitiveFlags = normalizeNarrativeMetacognitiveFlags(
    input.metacognitiveFlags,
    { contextPrefix: ERROR_PREFIX },
  );
  const deliberation = normalizeValuesDeliberationMetadata(input.deliberation, { strict: true });

  return {
    occurredAt: normalizeOccurredAt(input.occurredAt, now),
    initiatorSurface: normalizeRequiredString(input.initiatorSurface, 'initiatorSurface'),
    initiatedBy: normalizeRequiredString(input.initiatedBy, 'initiatedBy'),
    ...(normalizeOptionalString(input.reason, 'reason') ? { reason: normalizeOptionalString(input.reason, 'reason') } : {}),
    ...(normalizeOptionalString(input.templateId, 'templateId') ? { templateId: normalizeOptionalString(input.templateId, 'templateId') } : {}),
    ...(normalizeOptionalString(input.templateName, 'templateName') ? { templateName: normalizeOptionalString(input.templateName, 'templateName') } : {}),
    ...(input.executionSource ? { executionSource: input.executionSource } : {}),
    ...(normalizeOptionalString(input.channelId, 'channelId') ? { channelId: normalizeOptionalString(input.channelId, 'channelId') } : {}),
    ...(input.sendToDiscordEffective !== undefined
      ? { sendToDiscordEffective: normalizeRequiredBoolean(input.sendToDiscordEffective, 'sendToDiscordEffective') }
      : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
    ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
    ...(normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId')
      ? { reflectionJournalEntryId: normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId') }
      : {}),
    ...(normalizeOptionalString(input.dailyJournalEntryId, 'dailyJournalEntryId')
      ? { dailyJournalEntryId: normalizeOptionalString(input.dailyJournalEntryId, 'dailyJournalEntryId') }
      : {}),
    ...(normalizeOptionalString(input.processId, 'processId') ? { processId: normalizeOptionalString(input.processId, 'processId') } : {}),
    ...(normalizeOptionalString(input.prompt, 'prompt') ? { prompt: normalizeOptionalString(input.prompt, 'prompt') } : {}),
    ...(normalizeOptionalString(input.reflection, 'reflection') ? { reflection: normalizeOptionalString(input.reflection, 'reflection') } : {}),
    ...(deliberation ? { deliberation } : {}),
    ...(normalizeOptionalString(input.substrateBoundary, 'substrateBoundary')
      ? { substrateBoundary: normalizeOptionalString(input.substrateBoundary, 'substrateBoundary') }
      : {}),
    ...(normalizeStringArray(input.substrateProvenanceRefs, 'substrateProvenanceRefs')
      ? { substrateProvenanceRefs: normalizeStringArray(input.substrateProvenanceRefs, 'substrateProvenanceRefs') }
      : {}),
  };
}

function buildEntryId(now: () => number): string {
  return `reflection-metacognition-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

function normalizeRunEntry(
  input: ReflectionRunMetacognitionEntryInput,
  now: () => number,
): ReflectionMetacognitionJournalEntry {
  const entry = normalizeBaseEntry(input, now);
  return {
    id: buildEntryId(now),
    kind: 'reflection_run',
    ...entry,
    templateId: normalizeRequiredString(input.templateId, 'templateId'),
    templateName: normalizeRequiredString(input.templateName, 'templateName'),
    executionSource: input.executionSource,
    channelId: normalizeRequiredString(input.channelId, 'channelId'),
    sendToDiscordEffective: normalizeRequiredBoolean(input.sendToDiscordEffective, 'sendToDiscordEffective'),
    mode: input.mode,
    prompt: normalizeRequiredString(input.prompt, 'prompt'),
    reflection: normalizeRequiredString(input.reflection, 'reflection'),
  };
}

function normalizeMutationEntry(
  input: ReflectionMutationMetacognitionEntryInput,
  now: () => number,
): ReflectionMetacognitionJournalEntry {
  const mutationBefore = normalizeMutationSnapshot(input.mutationBefore, 'mutationBefore');
  const mutationAfter = normalizeMutationSnapshot(input.mutationAfter, 'mutationAfter');
  const hasMutationBefore = mutationBefore !== undefined;
  const hasMutationAfter = mutationAfter !== undefined;
  if (!hasMutationBefore && !hasMutationAfter) {
    throw new Error('Reflection metacognition mutation entry requires mutationBefore or mutationAfter');
  }

  return {
    id: buildEntryId(now),
    kind: 'reflection_mutation',
    ...normalizeBaseEntry(input, now),
    ...(hasMutationBefore ? { mutationBefore } : {}),
    ...(hasMutationAfter ? { mutationAfter } : {}),
  };
}

function normalizePersistedEntry(raw: unknown): ReflectionMetacognitionJournalEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Partial<ReflectionMetacognitionJournalEntry>;
  const id = normalizeOptionalString(candidate.id, 'id');
  if (!id) {
    return null;
  }

  if (candidate.kind === 'reflection_run') {
    const base = normalizeBaseEntry(candidate as ReflectionRunMetacognitionEntryInput, Date.now);
    if (!base.templateId || !base.templateName || !base.executionSource || !base.channelId || base.sendToDiscordEffective === undefined || !base.mode || !base.prompt || !base.reflection) {
      return null;
    }
    return {
      id,
      kind: 'reflection_run',
      ...base,
      templateId: base.templateId,
      templateName: base.templateName,
      executionSource: base.executionSource,
      channelId: base.channelId,
      sendToDiscordEffective: base.sendToDiscordEffective,
      mode: base.mode,
      prompt: base.prompt,
      reflection: base.reflection,
    };
  }

  if (candidate.kind === 'reflection_mutation') {
    const base = normalizeBaseEntry(candidate as ReflectionMutationMetacognitionEntryInput, Date.now);
    const mutationBefore = normalizeMutationSnapshot(candidate.mutationBefore, 'mutationBefore');
    const mutationAfter = normalizeMutationSnapshot(candidate.mutationAfter, 'mutationAfter');
    if (mutationBefore === undefined && mutationAfter === undefined) {
      return null;
    }
    return {
      id,
      kind: 'reflection_mutation',
      ...base,
      ...(mutationBefore !== undefined ? { mutationBefore } : {}),
      ...(mutationAfter !== undefined ? { mutationAfter } : {}),
    };
  }

  return null;
}

function sortByOccurredAtDescending(
  entries: readonly ReflectionMetacognitionJournalEntry[],
): ReflectionMetacognitionJournalEntry[] {
  return [...entries].sort((left, right) => {
    const delta = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (delta !== 0) {
      return delta;
    }
    return right.id.localeCompare(left.id);
  });
}

export class ReflectionMetacognitionJournalStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly mirror?: ReflectionMetacognitionMirrorStore;

  constructor(
    filePath: string,
    options: {
      now?: () => number;
      mirror?: ReflectionMetacognitionMirrorStore;
    } = {},
  ) {
    this.filePath = filePath;
    this.now = options.now ?? Date.now;
    this.mirror = options.mirror;
  }

  async append(
    input: ReflectionMetacognitionJournalEntryInput,
  ): Promise<ReflectionMetacognitionJournalEntry> {
    const entry = input.kind === 'reflection_mutation'
      ? normalizeMutationEntry(input, this.now)
      : normalizeRunEntry(input, this.now);

    appendJsonLine(this.filePath, entry);
    if (this.mirror) {
      try {
        await this.mirror.mirrorEntry(entry);
      } catch (error) {
        log.warn('Failed to mirror reflection metacognition entry into database backend', {
          id: entry.id,
          kind: entry.kind,
          error: String(error),
        });
      }
    }

    log.debug('Persisted reflection metacognition entry', {
      id: entry.id,
      kind: entry.kind,
      templateId: entry.templateId,
      processId: entry.processId,
    });
    return entry;
  }

  listRecent(
    options: ReflectionMetacognitionJournalListOptions = {},
  ): ReflectionMetacognitionJournalEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    if (raw.trim().length === 0) {
      return [];
    }

    const entries = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map((line, index) => {
        try {
          return normalizePersistedEntry(JSON.parse(line) as unknown);
        } catch (error) {
          log.warn('Skipping unreadable reflection metacognition journal line', {
            filePath: this.filePath,
            line: index + 1,
            error: String(error),
          });
          return null;
        }
      })
      .filter((entry): entry is ReflectionMetacognitionJournalEntry => entry !== null);

    const sorted = sortByOccurredAtDescending(entries);
    if (options.limit === undefined) {
      return sorted;
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error('limit must be a positive integer when provided');
    }
    return sorted.slice(0, options.limit);
  }
}
