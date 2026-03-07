import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { cloneInternalState, type InternalState } from '../self-model/state.js';

const log = createComponentLogger('ValuesJournal');
const COMPANION_VALUES_TEMPLATE_ID = 'values-reflection';
const DEFAULT_COMPANION_LAYER_HISTORY_LIMIT = 6;
const MAX_COMPANION_LAYER_HISTORY_LIMIT = 24;

export interface ValuesJournalEntry {
  id: string;
  version: number;
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  createdAt: string;
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  provenance?: ValuesEntryProvenance;
}

export interface ValuesJournalAppendInput {
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  createdAt?: string;
  deliberation?: ValuesDeliberationMetadata;
  internalStateSnapshotRef?: string;
  internalState?: InternalState;
  metacognitiveFlags?: ValuesMetacognitiveFlag[];
  provenance?: ValuesEntryProvenance;
}

interface ValuesJournalListOptions {
  limit?: number;
}

interface ValuesJournalStoreOptions {
  legacyFilePaths?: string[];
}

export interface ValuesDeliberationMetadata {
  sessionId: string;
  stopReason: string;
  rounds: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

export interface ValuesMetacognitiveFlag {
  flag: string;
  confidence: number;
  evidence?: string;
}

export type ValuesEntryProvenanceSource =
  | 'companion_reflection'
  | 'values_add_tool'
  | 'values_update_tool';

export interface ValuesEntryProvenance {
  source: ValuesEntryProvenanceSource;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  mode?: 'agent' | 'deliberation';
  reflectionJournalEntryId?: string;
  derivedFromVersion?: number;
}

export interface CompanionDerivedValuesLayer {
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
}

interface CompanionDerivedLayerOptions {
  historyLimit?: number;
}

function normalizeDeliberationMetadata(raw: unknown): ValuesDeliberationMetadata | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ValuesDeliberationMetadata>;

  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.trim().length === 0) return undefined;
  if (typeof candidate.stopReason !== 'string' || candidate.stopReason.trim().length === 0) return undefined;
  if (typeof candidate.rounds !== 'number' || !Number.isFinite(candidate.rounds) || candidate.rounds < 0) {
    return undefined;
  }
  if (
    typeof candidate.totalInputTokens !== 'number'
    || !Number.isFinite(candidate.totalInputTokens)
    || candidate.totalInputTokens < 0
  ) {
    return undefined;
  }
  if (
    typeof candidate.totalOutputTokens !== 'number'
    || !Number.isFinite(candidate.totalOutputTokens)
    || candidate.totalOutputTokens < 0
  ) {
    return undefined;
  }
  if (typeof candidate.totalTokens !== 'number' || !Number.isFinite(candidate.totalTokens) || candidate.totalTokens < 0) {
    return undefined;
  }
  if (
    typeof candidate.estimatedCostUsd !== 'number'
    || !Number.isFinite(candidate.estimatedCostUsd)
    || candidate.estimatedCostUsd < 0
  ) {
    return undefined;
  }
  if (typeof candidate.durationMs !== 'number' || !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0) {
    return undefined;
  }

  return {
    sessionId: candidate.sessionId,
    stopReason: candidate.stopReason,
    rounds: Math.floor(candidate.rounds),
    totalInputTokens: candidate.totalInputTokens,
    totalOutputTokens: candidate.totalOutputTokens,
    totalTokens: candidate.totalTokens,
    estimatedCostUsd: candidate.estimatedCostUsd,
    durationMs: candidate.durationMs,
  };
}

function normalizeSnapshotRef(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('values journal internalStateSnapshotRef must be a non-empty string when provided');
  }
  return raw.trim();
}

function normalizeInternalStateSnapshot(raw: unknown): InternalState | undefined {
  if (raw === undefined || raw === null) return undefined;
  return cloneInternalState(raw as InternalState);
}

function normalizeMetacognitiveFlags(raw: unknown): ValuesMetacognitiveFlag[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('values journal metacognitiveFlags must be an array when provided');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`values journal metacognitiveFlags[${String(index)}] must be an object`);
    }
    const flagRaw = (entry as { flag?: unknown }).flag;
    if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
      throw new Error(`values journal metacognitiveFlags[${String(index)}].flag must be a non-empty string`);
    }
    const confidenceRaw = (entry as { confidence?: unknown }).confidence;
    if (
      typeof confidenceRaw !== 'number'
      || !Number.isFinite(confidenceRaw)
      || confidenceRaw < 0
      || confidenceRaw > 1
    ) {
      throw new Error(`values journal metacognitiveFlags[${String(index)}].confidence must be in [0, 1]`);
    }
    const evidenceRaw = (entry as { evidence?: unknown }).evidence;
    if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
      throw new Error(`values journal metacognitiveFlags[${String(index)}].evidence must be a non-empty string`);
    }
    return {
      flag: flagRaw.trim(),
      confidence: Number(confidenceRaw.toFixed(4)),
      ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
    };
  });
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProvenance(
  raw: unknown,
  options: { strict: boolean } = { strict: false },
): ValuesEntryProvenance | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    if (options.strict) {
      throw new Error('values journal provenance must be an object when provided');
    }
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  const source = candidate.source;
  if (source !== 'companion_reflection' && source !== 'values_add_tool' && source !== 'values_update_tool') {
    if (options.strict) {
      throw new Error('values journal provenance.source is invalid');
    }
    return undefined;
  }

  const templateId = normalizeOptionalNonEmptyString(candidate.templateId);
  const templateName = normalizeOptionalNonEmptyString(candidate.templateName);
  const channelId = normalizeOptionalNonEmptyString(candidate.channelId);
  const reflectionJournalEntryId = normalizeOptionalNonEmptyString(candidate.reflectionJournalEntryId);

  const modeRaw = candidate.mode;
  let mode: 'agent' | 'deliberation' | undefined;
  if (modeRaw !== undefined) {
    if (modeRaw !== 'agent' && modeRaw !== 'deliberation') {
      if (options.strict) {
        throw new Error('values journal provenance.mode is invalid');
      }
      mode = undefined;
    } else {
      mode = modeRaw;
    }
  }

  const derivedFromVersionRaw = candidate.derivedFromVersion;
  let derivedFromVersion: number | undefined;
  if (derivedFromVersionRaw !== undefined) {
    if (
      typeof derivedFromVersionRaw !== 'number'
      || !Number.isInteger(derivedFromVersionRaw)
      || derivedFromVersionRaw < 1
    ) {
      if (options.strict) {
        throw new Error('values journal provenance.derivedFromVersion must be an integer >= 1');
      }
    } else {
      derivedFromVersion = derivedFromVersionRaw;
    }
  }

  return {
    source,
    ...(templateId ? { templateId } : {}),
    ...(templateName ? { templateName } : {}),
    ...(channelId ? { channelId } : {}),
    ...(mode ? { mode } : {}),
    ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
    ...(derivedFromVersion ? { derivedFromVersion } : {}),
  };
}

function normalizeCompanionLayerHistoryLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_COMPANION_LAYER_HISTORY_LIMIT;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error('companion layer historyLimit must be an integer');
  }
  if (raw < 1 || raw > MAX_COMPANION_LAYER_HISTORY_LIMIT) {
    throw new Error(
      `companion layer historyLimit must be between 1 and ${String(MAX_COMPANION_LAYER_HISTORY_LIMIT)}`,
    );
  }
  return raw;
}

function sanitizeReflectionForCompanionLayer(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isCompanionDerivedEntry(entry: ValuesJournalEntry): boolean {
  if (entry.provenance?.source === 'companion_reflection') return true;
  return entry.templateId === COMPANION_VALUES_TEMPLATE_ID;
}

function toProvenanceRef(entry: ValuesJournalEntry): string {
  const source = entry.provenance?.source ?? 'legacy_values_entry';
  const templateId = entry.provenance?.templateId ?? entry.templateId;
  const channelId = entry.provenance?.channelId ?? 'unknown_channel';
  return `values:${entry.id}|source:${source}|template:${templateId}|channel:${channelId}`;
}

function toCompanionHistoryLine(entry: ValuesJournalEntry): string {
  const source = entry.provenance?.source ?? 'legacy_values_entry';
  const mode = entry.provenance?.mode ?? 'unknown';
  const template = entry.provenance?.templateId ?? entry.templateId;
  const reflection = sanitizeReflectionForCompanionLayer(entry.reflection);
  return `- v${String(entry.version)} @ ${entry.createdAt} (${source}; template=${template}; mode=${mode}): ${reflection}`;
}

function normalizeEntry(raw: unknown): ValuesJournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ValuesJournalEntry>;
  if (
    typeof entry.version !== 'number'
    || !Number.isInteger(entry.version)
    || entry.version < 1
    || typeof entry.templateId !== 'string'
    || entry.templateId.trim().length === 0
    || typeof entry.templateName !== 'string'
    || entry.templateName.trim().length === 0
    || typeof entry.prompt !== 'string'
    || entry.prompt.trim().length === 0
    || typeof entry.reflection !== 'string'
    || entry.reflection.trim().length === 0
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
  ) {
    return null;
  }

  const id = typeof entry.id === 'string' && entry.id.trim().length > 0
    ? entry.id
    : `values-${entry.version}`;
  try {
    const deliberation = normalizeDeliberationMetadata(entry.deliberation);
    const internalStateSnapshotRef = normalizeSnapshotRef((entry as { internalStateSnapshotRef?: unknown }).internalStateSnapshotRef);
    const internalState = normalizeInternalStateSnapshot((entry as { internalState?: unknown }).internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags((entry as { metacognitiveFlags?: unknown }).metacognitiveFlags);
    const provenance = normalizeProvenance((entry as { provenance?: unknown }).provenance);
    if ((internalStateSnapshotRef || internalState || metacognitiveFlags) && (!internalStateSnapshotRef || !internalState)) {
      return null;
    }

    return {
      id,
      version: entry.version,
      templateId: entry.templateId,
      templateName: entry.templateName,
      prompt: entry.prompt,
      reflection: entry.reflection,
      createdAt: entry.createdAt,
      ...(deliberation ? { deliberation } : {}),
      ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      ...(internalState ? { internalState } : {}),
      ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
      ...(provenance ? { provenance } : {}),
    };
  } catch {
    return null;
  }
}

export class ValuesJournalStore {
  private readonly filePath: string;
  private readonly legacyFilePaths: string[];
  private migratedLegacy = false;

  constructor(filePath: string, options: ValuesJournalStoreOptions = {}) {
    this.filePath = filePath;
    this.legacyFilePaths = (options.legacyFilePaths ?? [])
      .map(path => path.trim())
      .filter(path => path.length > 0 && path !== filePath);
  }

  append(input: ValuesJournalAppendInput): ValuesJournalEntry {
    this.ensureLegacyMigration();
    const templateId = input.templateId.trim();
    const templateName = input.templateName.trim();
    const prompt = input.prompt.trim();
    const reflection = input.reflection.trim();

    if (!templateId || !templateName || !prompt || !reflection) {
      throw new Error('values journal append requires non-empty templateId, templateName, prompt, and reflection');
    }

    const entries = this.readAll();
    const nextVersion = entries.length > 0 ? entries[entries.length - 1]!.version + 1 : 1;
    const internalStateSnapshotRef = normalizeSnapshotRef(input.internalStateSnapshotRef);
    const internalState = normalizeInternalStateSnapshot(input.internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags(input.metacognitiveFlags);
    const provenance = normalizeProvenance(input.provenance, { strict: true });
    if ((internalStateSnapshotRef || internalState || metacognitiveFlags) && (!internalStateSnapshotRef || !internalState)) {
      throw new Error(
        'values journal append requires both internalStateSnapshotRef and internalState when narrative context is provided',
      );
    }
    const entry: ValuesJournalEntry = {
      id: `values-${nextVersion}`,
      version: nextVersion,
      templateId,
      templateName,
      prompt,
      reflection,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.deliberation ? { deliberation: input.deliberation } : {}),
      ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      ...(internalState ? { internalState } : {}),
      ...(metacognitiveFlags ? { metacognitiveFlags } : {}),
      ...(provenance ? { provenance } : {}),
    };

    appendJsonLine(this.filePath, entry);
    return entry;
  }

  list(options: ValuesJournalListOptions = {}): ValuesJournalEntry[] {
    this.ensureLegacyMigration();
    const entries = this.readAll().reverse();
    if (options.limit === undefined || options.limit < 1) {
      return entries;
    }
    return entries.slice(0, options.limit);
  }

  buildCompanionDerivedLayer(options: CompanionDerivedLayerOptions = {}): CompanionDerivedValuesLayer | null {
    this.ensureLegacyMigration();
    const historyLimit = normalizeCompanionLayerHistoryLimit(options.historyLimit);
    const companionEntries = this.readAll()
      .filter(entry => isCompanionDerivedEntry(entry));
    if (companionEntries.length === 0) {
      return null;
    }

    const selected = companionEntries
      .slice()
      .sort((left, right) => right.version - left.version)
      .slice(0, historyLimit)
      .sort((left, right) => left.version - right.version);
    if (selected.length === 0) {
      return null;
    }

    const lines = [
      'Secondary companion-values layer derived from append-only values journal history.',
      `history_depth: ${String(selected.length)}`,
      `latest_version: ${String(selected[selected.length - 1]!.version)}`,
      '',
      '[History]',
      ...selected.map(entry => toCompanionHistoryLine(entry)),
    ];

    return {
      content: lines.join('\n'),
      provenanceRefs: selected.map(entry => toProvenanceRef(entry)),
      historyVersions: selected.map(entry => entry.version),
      entryIds: selected.map(entry => entry.id),
    };
  }

  private readAll(): ValuesJournalEntry[] {
    this.ensureLegacyMigration();
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf-8');
    if (raw.trim().length === 0) return [];

    const lines = raw.split('\n');
    const entries: ValuesJournalEntry[] = [];
    for (const [idx, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const entry = normalizeEntry(parsed);
        if (entry) {
          entries.push(entry);
        } else {
          log.warn('Skipping malformed values journal entry', { line: idx + 1 });
        }
      } catch (error) {
        log.warn('Skipping unreadable values journal line', {
          line: idx + 1,
          error: String(error),
        });
      }
    }

    entries.sort((left, right) => left.version - right.version);
    return entries;
  }

  private ensureLegacyMigration(): void {
    if (this.migratedLegacy) return;
    this.migratedLegacy = true;

    if (existsSync(this.filePath)) return;
    for (const legacyPath of this.legacyFilePaths) {
      if (!existsSync(legacyPath)) continue;
      try {
        const raw = readFileSync(legacyPath, 'utf-8');
        if (raw.trim().length === 0) continue;
        mkdirSync(dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, raw, 'utf-8');
        return;
      } catch (error) {
        log.warn('Failed to migrate legacy values journal', {
          legacyPath,
          filePath: this.filePath,
          error: String(error),
        });
      }
    }
  }
}
