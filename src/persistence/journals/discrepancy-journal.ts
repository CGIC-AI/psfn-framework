// ── Emotional Discrepancy Journal ──
// Bead 031.11.2 (child 2/2 of 031.11).
//
// A durable, queryable record of the cross-family emotional divergences
// (031.11.1) that were surfaced to a reflection. Each entry carries every
// detected discrepancy VERBATIM — both sides with their own family, value,
// confidence, and twa0 provenance — so the "head and heart not in sync" state
// stays legible after the fact and is never compressed to a single tag or
// resolved into a coherent story (charter §8.3). Nothing here averages the two
// sides, picks a winner, or drops a signal.
//
// This follows the append-only JSONL pattern of reflection-journal.ts: strict,
// fail-closed validation on append; tolerant skip-and-continue on read so one
// corrupt line never sinks the whole log.

import { appendJsonLine, readJsonLines } from '../jsonl.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  EMOTION_DISCREPANCY_FAMILIES,
  EMOTION_DISCREPANCY_KINDS,
  type EmotionDiscrepancy,
  type EmotionDiscrepancySide,
  type EmotionTelemetryProvenance,
} from '../../shared/contracts/emotion-contracts.js';

const log = createComponentLogger('DiscrepancyJournal');

export interface DiscrepancyJournalEntryInput {
  templateId: string;
  templateName: string;
  channelId: string;
  internalStateSnapshotRef: string;
  discrepancies: EmotionDiscrepancy[];
  createdAt?: string;
}

export interface DiscrepancyJournalEntry {
  id: string;
  templateId: string;
  templateName: string;
  channelId: string;
  internalStateSnapshotRef: string;
  discrepancies: EmotionDiscrepancy[];
  createdAt: string;
}

export interface DiscrepancyJournalListOptions {
  limit?: number;
}

function requireFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Discrepancy journal ${fieldName} must be a finite number`);
  }
  return value;
}

function normalizeProvenance(value: unknown, fieldName: string): EmotionTelemetryProvenance[] {
  if (!Array.isArray(value)) {
    throw new Error(`Discrepancy journal ${fieldName} must be an array`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Discrepancy journal ${fieldName}[${String(index)}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.source !== 'string' || entry.source.trim().length === 0) {
      throw new Error(`Discrepancy journal ${fieldName}[${String(index)}].source must be a non-empty string`);
    }
    // Provenance is retained verbatim: source is the required key; the remaining
    // twa0 fields (modality, classifier, model, observedAtMs, provenanceRef) are
    // optional and carried through when present so neither side loses its trail.
    return {
      source: entry.source as EmotionTelemetryProvenance['source'],
      ...(typeof entry.observedAtMs === 'number' && Number.isFinite(entry.observedAtMs)
        ? { observedAtMs: entry.observedAtMs }
        : {}),
      ...(typeof entry.modality === 'string'
        ? { modality: entry.modality as EmotionTelemetryProvenance['modality'] }
        : {}),
      ...(typeof entry.classifier === 'string' ? { classifier: entry.classifier } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      ...(typeof entry.provenanceRef === 'string' ? { provenanceRef: entry.provenanceRef } : {}),
    };
  });
}

function normalizeDiscrepancySide(value: unknown, fieldName: string): EmotionDiscrepancySide {
  if (!value || typeof value !== 'object') {
    throw new Error(`Discrepancy journal ${fieldName} must be an object`);
  }
  const side = value as Record<string, unknown>;
  if (!EMOTION_DISCREPANCY_FAMILIES.includes(side.family as EmotionDiscrepancySide['family'])) {
    throw new Error(`Discrepancy journal ${fieldName}.family is not a recognized emotion family`);
  }
  if (typeof side.label !== 'string' || side.label.trim().length === 0) {
    throw new Error(`Discrepancy journal ${fieldName}.label must be a non-empty string`);
  }
  return {
    family: side.family as EmotionDiscrepancySide['family'],
    label: side.label,
    value: requireFiniteNumber(side.value, `${fieldName}.value`),
    confidence: requireFiniteNumber(side.confidence, `${fieldName}.confidence`),
    provenance: normalizeProvenance(side.provenance, `${fieldName}.provenance`),
  };
}

function normalizeDiscrepancy(value: unknown, fieldName: string): EmotionDiscrepancy {
  if (!value || typeof value !== 'object') {
    throw new Error(`Discrepancy journal ${fieldName} must be an object`);
  }
  const discrepancy = value as Record<string, unknown>;
  if (!EMOTION_DISCREPANCY_KINDS.includes(discrepancy.kind as EmotionDiscrepancy['kind'])) {
    throw new Error(`Discrepancy journal ${fieldName}.kind is not a recognized discrepancy kind`);
  }
  if (!Array.isArray(discrepancy.sides) || discrepancy.sides.length !== 2) {
    throw new Error(`Discrepancy journal ${fieldName}.sides must be a two-element array`);
  }
  return {
    kind: discrepancy.kind as EmotionDiscrepancy['kind'],
    magnitude: requireFiniteNumber(discrepancy.magnitude, `${fieldName}.magnitude`),
    sides: [
      normalizeDiscrepancySide(discrepancy.sides[0], `${fieldName}.sides[0]`),
      normalizeDiscrepancySide(discrepancy.sides[1], `${fieldName}.sides[1]`),
    ],
  };
}

function normalizeDiscrepancies(value: unknown, fieldName: string): EmotionDiscrepancy[] {
  if (!Array.isArray(value)) {
    throw new Error(`Discrepancy journal ${fieldName} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`Discrepancy journal ${fieldName} must not be empty`);
  }
  return value.map((entry, index) => normalizeDiscrepancy(entry, `${fieldName}[${String(index)}]`));
}

function normalizePersistedDiscrepancyEntry(raw: unknown): DiscrepancyJournalEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Partial<DiscrepancyJournalEntry>;
  if (
    typeof entry.id !== 'string'
    || typeof entry.templateId !== 'string'
    || typeof entry.templateName !== 'string'
    || typeof entry.channelId !== 'string'
    || typeof entry.internalStateSnapshotRef !== 'string'
    || typeof entry.createdAt !== 'string'
  ) {
    return null;
  }
  try {
    return {
      id: entry.id.trim(),
      templateId: entry.templateId.trim(),
      templateName: entry.templateName.trim(),
      channelId: entry.channelId.trim(),
      internalStateSnapshotRef: entry.internalStateSnapshotRef.trim(),
      createdAt: entry.createdAt.trim(),
      discrepancies: normalizeDiscrepancies(entry.discrepancies, 'discrepancies'),
    };
  } catch {
    return null;
  }
}

export class DiscrepancyJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(input: DiscrepancyJournalEntryInput): DiscrepancyJournalEntry {
    const templateId = input.templateId.trim();
    const templateName = input.templateName.trim();
    const channelId = input.channelId.trim();
    const internalStateSnapshotRef = input.internalStateSnapshotRef.trim();
    if (!templateId || !templateName || !channelId || !internalStateSnapshotRef) {
      throw new Error(
        'Discrepancy journal entry requires templateId, templateName, channelId, and internalStateSnapshotRef',
      );
    }
    // Fail closed: the descriptors are validated verbatim before they are
    // written, so a malformed side (missing provenance, non-finite value) is
    // rejected rather than silently persisted.
    const discrepancies = normalizeDiscrepancies(input.discrepancies, 'discrepancies');

    const entry: DiscrepancyJournalEntry = {
      id: `discrepancy-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
      templateId,
      templateName,
      channelId,
      internalStateSnapshotRef,
      createdAt: input.createdAt ?? new Date().toISOString(),
      discrepancies,
    };

    appendJsonLine(this.filePath, entry);
    log.debug('Persisted emotional discrepancy journal entry', {
      templateId: entry.templateId,
      channelId: entry.channelId,
      discrepancyCount: entry.discrepancies.length,
    });
    return entry;
  }

  listRecent(options: DiscrepancyJournalListOptions = {}): DiscrepancyJournalEntry[] {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Discrepancy journal listRecent limit must be a positive integer when provided');
    }
    return readJsonLines(this.filePath, normalizePersistedDiscrepancyEntry).entries
      .sort((left, right) => {
        const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (createdAtDelta !== 0) {
          return createdAtDelta;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(0, limit);
  }
}
