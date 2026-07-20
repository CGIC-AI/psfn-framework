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

export interface ReflectionJournalVAD {
  valence: number;
  arousal: number;
  dominance: number;
}

export type ReflectionConcernArcSource = 'decision' | 'grooming_stale' | 'grooming_cap';

/**
 * Structured concern-resolution arc (vw3w.2). Machine-readable scaffolding that
 * accompanies the companion-readable prose in the entry's `reflection`; kept in
 * telemetry (never the prose) per charter 8.6. Written only when the full arc is
 * available — both VADs present — so a partial arc is never persisted.
 */
export interface ReflectionConcernArc {
  concernId: string;
  resolutionGenerationId: string;
  formationVAD: ReflectionJournalVAD;
  resolutionVAD: ReflectionJournalVAD;
  reliefDelta: ReflectionJournalVAD;
  source: ReflectionConcernArcSource;
  durationMs?: number;
  finalSalience?: number;
}

export interface ReflectionJournalTelemetry {
  deliberation?: ValuesDeliberationMetadata;
  narrativeContext?: ReflectionJournalNarrativeContext;
  concernArc?: ReflectionConcernArc;
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
  concernArc?: ReflectionConcernArc;
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

export interface ReflectionConcernArcListOptions extends ReflectionJournalListOptions {
  concernId?: string;
  provenanceRef?: string;
}

export interface ReflectionConcernArcRecord {
  entryId: string;
  createdAt: string;
  substrateBoundary?: string;
  provenanceRefs: string[];
  arc: ReflectionConcernArc;
}

function normalizeConcernArcVAD(value: unknown, field: string): ReflectionJournalVAD {
  if (!value || typeof value !== 'object') {
    throw new Error(`Reflection journal concernArc.${field} must be a VAD object`);
  }
  const { valence, arousal, dominance } = value as Record<string, unknown>;
  for (const [axis, axisValue] of [['valence', valence], ['arousal', arousal], ['dominance', dominance]] as const) {
    if (typeof axisValue !== 'number' || !Number.isFinite(axisValue)) {
      throw new Error(`Reflection journal concernArc.${field}.${axis} must be a finite number`);
    }
  }
  return {
    valence: valence as number,
    arousal: arousal as number,
    dominance: dominance as number,
  };
}

function normalizeConcernArc(value: ReflectionConcernArc | undefined): ReflectionConcernArc | undefined {
  if (value === undefined) {
    return undefined;
  }
  const concernId = typeof value.concernId === 'string' ? value.concernId.trim() : '';
  if (!concernId) {
    throw new Error('Reflection journal concernArc requires a non-empty concernId');
  }
  const resolutionGenerationId = typeof value.resolutionGenerationId === 'string'
    ? value.resolutionGenerationId.trim()
    : '';
  if (!resolutionGenerationId) {
    throw new Error('Reflection journal concernArc requires a non-empty resolutionGenerationId');
  }
  // Widened to string: this is a fail-closed validator for persisted/untrusted
  // input, so the runtime check must not be elided by the static union type.
  const source = value.source as string;
  if (source !== 'decision' && source !== 'grooming_stale' && source !== 'grooming_cap') {
    throw new Error('Reflection journal concernArc.source must be decision, grooming_stale, or grooming_cap');
  }
  const durationMs = value.durationMs;
  if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    throw new Error('Reflection journal concernArc.durationMs must be a non-negative finite number when provided');
  }
  const finalSalience = value.finalSalience;
  if (finalSalience !== undefined && (typeof finalSalience !== 'number' || !Number.isFinite(finalSalience))) {
    throw new Error('Reflection journal concernArc.finalSalience must be a finite number when provided');
  }
  return {
    concernId,
    resolutionGenerationId,
    formationVAD: normalizeConcernArcVAD(value.formationVAD, 'formationVAD'),
    resolutionVAD: normalizeConcernArcVAD(value.resolutionVAD, 'resolutionVAD'),
    reliefDelta: normalizeConcernArcVAD(value.reliefDelta, 'reliefDelta'),
    source: value.source,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(finalSalience !== undefined ? { finalSalience } : {}),
  };
}

function normalizeReflectionTelemetry(
  input: ReflectionJournalEntryInput,
): ReflectionJournalTelemetry | undefined {
  const telemetryInput = input.telemetry;
  const deliberation = telemetryInput?.deliberation ?? input.deliberation;
  const concernArc = normalizeConcernArc(telemetryInput?.concernArc ?? input.concernArc);

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

  if (!narrativeInput && !deliberation && !concernArc) {
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

  if (!narrativeContext && !deliberation && !concernArc) {
    return undefined;
  }

  return {
    ...(deliberation ? { deliberation } : {}),
    ...(narrativeContext ? { narrativeContext } : {}),
    ...(concernArc ? { concernArc } : {}),
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
    return this.appendWithId(input, undefined);
  }

  hasEntry(id: string): boolean {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    return readJsonLines(this.filePath, normalizePersistedReflectionEntry).entries
      .some(entry => entry.id === normalizedId);
  }

  appendOnce(id: string, input: ReflectionJournalEntryInput): {
    entry: ReflectionJournalEntry;
    appended: boolean;
  } {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new Error('Reflection journal appendOnce id must be non-empty');
    }
    const existing = readJsonLines(this.filePath, normalizePersistedReflectionEntry).entries
      .find(entry => entry.id === normalizedId);
    if (existing) return { entry: existing, appended: false };
    return { entry: this.appendWithId(input, normalizedId), appended: true };
  }

  private appendWithId(
    input: ReflectionJournalEntryInput,
    stableId: string | undefined,
  ): ReflectionJournalEntry {
    const telemetry = normalizeReflectionTelemetry(input);
    const substrateBoundary = input.substrateBoundary?.trim();
    const substrateProvenanceRefs = normalizeProvenanceRefs(input.substrateProvenanceRefs);
    const entry: ReflectionJournalEntry = {
      id: stableId
        ?? `reflection-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
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

  listConcernArcs(options: ReflectionConcernArcListOptions = {}): ReflectionConcernArcRecord[] {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Reflection journal listConcernArcs limit must be a positive integer');
    }
    const concernId = options.concernId?.trim();
    const provenanceRef = options.provenanceRef?.trim();
    return readJsonLines(this.filePath, normalizePersistedReflectionEntry).entries
      .flatMap((entry): ReflectionConcernArcRecord[] => {
        let arc: ReflectionConcernArc | undefined;
        try {
          arc = normalizeConcernArc(entry.telemetry?.concernArc);
        } catch {
          return [];
        }
        if (!arc || (concernId && arc.concernId !== concernId)) return [];
        const provenanceRefs = entry.substrateProvenanceRefs ?? [];
        if (provenanceRef && !provenanceRefs.includes(provenanceRef)) return [];
        return [{
          entryId: entry.id,
          createdAt: entry.createdAt,
          ...(entry.substrateBoundary ? { substrateBoundary: entry.substrateBoundary } : {}),
          provenanceRefs: [...provenanceRefs],
          arc,
        }];
      })
      .sort((left, right) => (
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || right.entryId.localeCompare(left.entryId)
      ))
      .slice(0, limit);
  }
}
