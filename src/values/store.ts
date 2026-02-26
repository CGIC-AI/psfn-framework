import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ValuesJournal');

export interface ValuesJournalEntry {
  id: string;
  version: number;
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  createdAt: string;
  deliberation?: ValuesDeliberationMetadata;
}

export interface ValuesJournalAppendInput {
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  createdAt?: string;
  deliberation?: ValuesDeliberationMetadata;
}

interface ValuesJournalListOptions {
  limit?: number;
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
  const deliberation = normalizeDeliberationMetadata(entry.deliberation);

  return {
    id,
    version: entry.version,
    templateId: entry.templateId,
    templateName: entry.templateName,
    prompt: entry.prompt,
    reflection: entry.reflection,
    createdAt: entry.createdAt,
    ...(deliberation ? { deliberation } : {}),
  };
}

export class ValuesJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(input: ValuesJournalAppendInput): ValuesJournalEntry {
    const templateId = input.templateId.trim();
    const templateName = input.templateName.trim();
    const prompt = input.prompt.trim();
    const reflection = input.reflection.trim();

    if (!templateId || !templateName || !prompt || !reflection) {
      throw new Error('values journal append requires non-empty templateId, templateName, prompt, and reflection');
    }

    const entries = this.readAll();
    const nextVersion = entries.length > 0 ? entries[entries.length - 1]!.version + 1 : 1;
    const entry: ValuesJournalEntry = {
      id: `values-${nextVersion}`,
      version: nextVersion,
      templateId,
      templateName,
      prompt,
      reflection,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.deliberation ? { deliberation: input.deliberation } : {}),
    };

    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    return entry;
  }

  list(options: ValuesJournalListOptions = {}): ValuesJournalEntry[] {
    const entries = this.readAll().reverse();
    if (options.limit === undefined || options.limit < 1) {
      return entries;
    }
    return entries.slice(0, options.limit);
  }

  private readAll(): ValuesJournalEntry[] {
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
}
