import { existsSync, readFileSync } from 'node:fs';
import type { LLMProvider } from '../core/agent/contracts.js';
import { createComponentLogger } from '../shared/logger.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';

const log = createComponentLogger('CompressionGuideline');

export const DEFAULT_COMPRESSION_GUIDELINE_TEXT = [
  'Preserve user goals, unresolved asks, and explicit commitments verbatim.',
  'Never collapse concrete identifiers: issue IDs, file paths, branch names, tool names, and config keys.',
  'Keep causal chains explicit (what changed, why, and what remains blocked).',
  'Prefer terse factual statements over broad paraphrase; mark uncertainty instead of guessing.',
].join('\n');

const DEFAULT_MINIMUM_FAILURES_FOR_UPDATE = 2;
const DEFAULT_FAILURE_REVIEW_LIMIT = 25;
const DEFAULT_TRAJECTORY_MAX_AGE_MS = 30 * 60_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_RESPONSE_CHARS = 3_000;

export interface CompressionGuidelineRecord {
  version: number;
  updatedAt: string;
  guideline: string;
  lastReviewedFailureAt?: number;
}

export interface CompressionFailureLogEntry {
  id: string;
  channelId: string;
  sourceMessageId: string;
  indicator: string;
  detectedAt: number;
  assistantResponse: string;
  originalContext: string;
  compressedContext: string;
  guidelineVersion: number;
  compactionCapturedAt: number;
}

export interface CompressionFailureSignal {
  indicator: string;
  matchedText: string;
}

export interface CompressionCompactionTrajectory {
  channelId: string;
  capturedAt: number;
  originalContext: string;
  compressedContext: string;
  guidelineVersion: number;
}

export interface CompressionGuidelineUpdateResult {
  status: 'updated' | 'skipped';
  reviewedFailureCount: number;
  reason?: 'no_new_failures' | 'insufficient_failures' | 'no_guideline_change';
  version?: number;
}

interface CompressionGuidelineStoreOptions {
  now?: () => number;
}

interface CompressionFailureLogStoreOptions {
  now?: () => number;
}

interface CompressionFailureLogListOptions {
  limit?: number;
}

interface CompressionGuidelineRuntimeOptions {
  now?: () => number;
  minimumFailuresForUpdate?: number;
  failureReviewLimit?: number;
  trajectoryMaxAgeMs?: number;
}

interface CompressionFailureLogAppendInput {
  channelId: string;
  sourceMessageId: string;
  indicator: string;
  assistantResponse: string;
  originalContext: string;
  compressedContext: string;
  guidelineVersion: number;
  compactionCapturedAt: number;
  detectedAt?: number;
}

interface GuidelineUpdateProposal {
  updatedGuideline: string;
}

export interface CompressionFailureCaptureInput {
  channelId: string;
  sourceMessageId: string;
  assistantResponse: string;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function normalizeFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeGuidelineRecord(
  raw: unknown,
  _fallbackUpdatedAt: string,
): CompressionGuidelineRecord | null {
  const record = parseJsonRecord(raw);
  if (!record) return null;

  const version = normalizeFiniteInteger(record.version);
  const updatedAt = normalizeIsoTimestamp(record.updatedAt);
  const guideline = typeof record.guideline === 'string'
    ? record.guideline.trim()
    : '';
  const lastReviewedFailureAt = normalizeFiniteInteger(record.lastReviewedFailureAt);

  if (version === undefined || version < 1) return null;
  if (!updatedAt) return null;
  if (!guideline) return null;

  return {
    version,
    updatedAt,
    guideline,
    ...(lastReviewedFailureAt !== undefined && lastReviewedFailureAt >= 0
      ? { lastReviewedFailureAt }
      : {}),
  };
}

function normalizeFailureLogEntry(raw: unknown): CompressionFailureLogEntry | null {
  const record = parseJsonRecord(raw);
  if (!record) return null;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const channelId = typeof record.channelId === 'string' ? record.channelId.trim() : '';
  const sourceMessageId = typeof record.sourceMessageId === 'string' ? record.sourceMessageId.trim() : '';
  const indicator = typeof record.indicator === 'string' ? record.indicator.trim() : '';
  const detectedAt = normalizeFiniteInteger(record.detectedAt);
  const assistantResponse = typeof record.assistantResponse === 'string'
    ? record.assistantResponse.trim()
    : '';
  const originalContext = typeof record.originalContext === 'string'
    ? record.originalContext.trim()
    : '';
  const compressedContext = typeof record.compressedContext === 'string'
    ? record.compressedContext.trim()
    : '';
  const guidelineVersion = normalizeFiniteInteger(record.guidelineVersion);
  const compactionCapturedAt = normalizeFiniteInteger(record.compactionCapturedAt);

  if (!id || !channelId || !sourceMessageId || !indicator) return null;
  if (detectedAt === undefined || detectedAt <= 0) return null;
  if (!assistantResponse || !originalContext || !compressedContext) return null;
  if (guidelineVersion === undefined || guidelineVersion < 1) return null;
  if (compactionCapturedAt === undefined || compactionCapturedAt <= 0) return null;

  return {
    id,
    channelId,
    sourceMessageId,
    indicator,
    detectedAt,
    assistantResponse,
    originalContext,
    compressedContext,
    guidelineVersion,
    compactionCapturedAt,
  };
}

function buildFailureId(now: number): string {
  const randomSuffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, '0');
  return `compfail-${now.toString(36)}-${randomSuffix}`;
}

const FAILURE_SIGNAL_RULES: Array<{ indicator: string; matchedText: string; regex: RegExp }> = [
  {
    indicator: 'asked_for_reminder',
    matchedText: 'asked to be reminded/repeated',
    regex: /\b(can|could)\s+you\s+(remind|repeat|restate)\b/i,
  },
  {
    indicator: 'explicit_missing_context',
    matchedText: 'explicit missing/lost context acknowledgment',
    regex: /\b(i\s+(may|might)\s+(be\s+)?(missing|lost)\s+(some\s+)?context)\b/i,
  },
  {
    indicator: 'asks_which_item',
    matchedText: 'asks which project/task/thread is active',
    regex: /\bwhich\s+(project|task|issue|thread)\s+(are|were)\s+we\b/i,
  },
];

function parseGuidelineUpdateProposal(raw: string): GuidelineUpdateProposal {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) {
    candidates.push(trimmed);
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      candidates.push(fencedMatch[1].trim());
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }
  }

  const dedupedCandidates = [...new Set(candidates.filter(candidate => candidate.length > 0))];
  for (const candidate of dedupedCandidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = parseJsonRecord(parsed);
      const updatedGuideline = record && typeof record.updatedGuideline === 'string'
        ? record.updatedGuideline.trim()
        : '';
      if (updatedGuideline) {
        return { updatedGuideline };
      }
    } catch (error) {
      log.debug('Guideline update proposal JSON parse candidate failed', {
        error: String(error),
      });
    }
  }

  throw new Error('Guideline update model output did not contain valid JSON with updatedGuideline');
}

function normalizeGuidelineText(value: string): string {
  return value
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, index, lines) => !(line.length === 0 && lines[index - 1] === ''))
    .join('\n')
    .trim();
}

function summarizeFailuresForPrompt(failures: CompressionFailureLogEntry[]): string {
  return failures
    .map((entry, index) => {
      const position = index + 1;
      const responseExcerpt = clampText(entry.assistantResponse, 500);
      const compressedExcerpt = clampText(entry.compressedContext, 1_000);
      const originalExcerpt = clampText(entry.originalContext, 1_000);
      return [
        `Failure ${position}:`,
        `- indicator: ${entry.indicator}`,
        `- assistant_response: ${responseExcerpt}`,
        `- compressed_context: ${compressedExcerpt}`,
        `- original_context: ${originalExcerpt}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function detectCompressionFailureSignal(responseText: string): CompressionFailureSignal | null {
  const normalized = compactWhitespace(responseText);
  if (!normalized) return null;
  if (normalized.length > MAX_RESPONSE_CHARS) return null;

  for (const rule of FAILURE_SIGNAL_RULES) {
    if (rule.regex.test(normalized)) {
      return {
        indicator: rule.indicator,
        matchedText: rule.matchedText,
      };
    }
  }
  return null;
}

export class CompressionGuidelineStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(filePath: string, options: CompressionGuidelineStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? Date.now;
  }

  load(): CompressionGuidelineRecord {
    const fallbackUpdatedAt = new Date(this.now()).toISOString();
    if (!existsSync(this.filePath)) {
      return {
        version: 1,
        updatedAt: fallbackUpdatedAt,
        guideline: DEFAULT_COMPRESSION_GUIDELINE_TEXT,
      };
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`Compression guideline store is unreadable: ${this.filePath} is empty`);
    }

    const parsed = JSON.parse(trimmed) as unknown;
    const normalized = normalizeGuidelineRecord(parsed, fallbackUpdatedAt);
    if (!normalized) {
      throw new Error(`Compression guideline store contains malformed data: ${this.filePath}`);
    }
    return normalized;
  }

  save(record: CompressionGuidelineRecord): CompressionGuidelineRecord {
    const normalized = normalizeGuidelineRecord(record, new Date(this.now()).toISOString());
    if (!normalized) {
      throw new Error('Compression guideline record is malformed');
    }
    writeJsonAtomic(this.filePath, normalized);
    return normalized;
  }
}

export class CompressionFailureLogStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(filePath: string, options: CompressionFailureLogStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? Date.now;
  }

  append(input: CompressionFailureLogAppendInput): CompressionFailureLogEntry {
    const now = this.now();
    const channelId = input.channelId.trim();
    const sourceMessageId = input.sourceMessageId.trim();
    const indicator = input.indicator.trim();
    const assistantResponse = clampText(input.assistantResponse, MAX_RESPONSE_CHARS).trim();
    const originalContext = clampText(input.originalContext, MAX_CONTEXT_CHARS).trim();
    const compressedContext = clampText(input.compressedContext, MAX_CONTEXT_CHARS).trim();
    const guidelineVersion = Math.max(1, Math.floor(input.guidelineVersion));
    const compactionCapturedAt = Math.max(1, Math.floor(input.compactionCapturedAt));
    const detectedAt = input.detectedAt !== undefined
      ? Math.max(1, Math.floor(input.detectedAt))
      : now;

    if (!channelId || !sourceMessageId || !indicator) {
      throw new Error('Compression failure log append requires channelId, sourceMessageId, and indicator');
    }
    if (!assistantResponse || !originalContext || !compressedContext) {
      throw new Error('Compression failure log append requires assistantResponse and context snapshots');
    }

    const entry: CompressionFailureLogEntry = {
      id: buildFailureId(now),
      channelId,
      sourceMessageId,
      indicator,
      detectedAt,
      assistantResponse,
      originalContext,
      compressedContext,
      guidelineVersion,
      compactionCapturedAt,
    };

    appendJsonLine(this.filePath, entry);
    return entry;
  }

  listSince(
    sinceTimestamp: number,
    options: CompressionFailureLogListOptions = {},
  ): CompressionFailureLogEntry[] {
    const normalizedSince = Number.isFinite(sinceTimestamp)
      ? Math.max(0, Math.floor(sinceTimestamp))
      : 0;
    const limit = options.limit !== undefined
      ? Math.max(1, Math.floor(options.limit))
      : DEFAULT_FAILURE_REVIEW_LIMIT;

    const all = this.readAll();
    const filtered = all.filter(entry => entry.detectedAt > normalizedSince);
    if (filtered.length <= limit) {
      return filtered;
    }
    return filtered.slice(filtered.length - limit);
  }

  listRecent(options: CompressionFailureLogListOptions = {}): CompressionFailureLogEntry[] {
    const limit = options.limit !== undefined
      ? Math.max(1, Math.floor(options.limit))
      : DEFAULT_FAILURE_REVIEW_LIMIT;
    const all = this.readAll();
    if (all.length <= limit) return all;
    return all.slice(all.length - limit);
  }

  private readAll(): CompressionFailureLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf-8');
    if (!raw.trim()) return [];

    const entries: CompressionFailureLogEntry[] = [];
    const lines = raw.split('\n');
    for (const [lineIndex, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const entry = normalizeFailureLogEntry(parsed);
        if (!entry) {
          log.warn('Skipping malformed compression failure log entry', {
            filePath: this.filePath,
            line: lineIndex + 1,
          });
          continue;
        }
        entries.push(entry);
      } catch (error) {
        log.warn('Skipping unreadable compression failure log line', {
          filePath: this.filePath,
          line: lineIndex + 1,
          error: String(error),
        });
      }
    }

    entries.sort((left, right) => left.detectedAt - right.detectedAt);
    return entries;
  }
}

export class CompressionGuidelineRuntime {
  private readonly guidelineStore: CompressionGuidelineStore;
  private readonly failureLogStore: CompressionFailureLogStore;
  private readonly now: () => number;
  private readonly minimumFailuresForUpdate: number;
  private readonly failureReviewLimit: number;
  private readonly trajectoryMaxAgeMs: number;
  private readonly latestTrajectories = new Map<string, CompressionCompactionTrajectory>();
  private readonly loggedSourceMessages = new Set<string>();

  constructor(
    guidelineStore: CompressionGuidelineStore,
    failureLogStore: CompressionFailureLogStore,
    options: CompressionGuidelineRuntimeOptions = {},
  ) {
    this.guidelineStore = guidelineStore;
    this.failureLogStore = failureLogStore;
    this.now = options.now ?? Date.now;
    this.minimumFailuresForUpdate = options.minimumFailuresForUpdate !== undefined
      ? Math.max(1, Math.floor(options.minimumFailuresForUpdate))
      : DEFAULT_MINIMUM_FAILURES_FOR_UPDATE;
    this.failureReviewLimit = options.failureReviewLimit !== undefined
      ? Math.max(1, Math.floor(options.failureReviewLimit))
      : DEFAULT_FAILURE_REVIEW_LIMIT;
    this.trajectoryMaxAgeMs = options.trajectoryMaxAgeMs !== undefined
      ? Math.max(1, Math.floor(options.trajectoryMaxAgeMs))
      : DEFAULT_TRAJECTORY_MAX_AGE_MS;
  }

  buildCompactionPrompt(basePrompt: string): string {
    const normalizedBasePrompt = basePrompt.trim();
    if (!normalizedBasePrompt) {
      throw new Error('Compaction prompt base text must be non-empty');
    }
    const guideline = this.guidelineStore.load();
    const normalizedGuideline = normalizeGuidelineText(guideline.guideline);
    if (!normalizedGuideline) {
      throw new Error('Compression guideline text is empty');
    }
    return [
      normalizedBasePrompt,
      `[Compression Guideline v${guideline.version}]`,
      normalizedGuideline,
    ].join('\n\n');
  }

  recordCompactionTrajectory(input: {
    channelId: string;
    originalContext: string;
    compressedContext: string;
    capturedAt?: number;
  }): void {
    const channelId = input.channelId.trim();
    const originalContext = clampText(input.originalContext, MAX_CONTEXT_CHARS).trim();
    const compressedContext = clampText(input.compressedContext, MAX_CONTEXT_CHARS).trim();
    if (!channelId || !originalContext || !compressedContext) {
      return;
    }
    const guidelineVersion = this.guidelineStore.load().version;
    const capturedAt = input.capturedAt !== undefined
      ? Math.max(1, Math.floor(input.capturedAt))
      : this.now();
    this.latestTrajectories.set(channelId, {
      channelId,
      capturedAt,
      originalContext,
      compressedContext,
      guidelineVersion,
    });
  }

  captureFailureFromResponse(input: CompressionFailureCaptureInput): CompressionFailureLogEntry | null {
    const signal = detectCompressionFailureSignal(input.assistantResponse);
    if (!signal) return null;

    const channelId = input.channelId.trim();
    const sourceMessageId = input.sourceMessageId.trim();
    if (!channelId || !sourceMessageId) return null;

    const dedupeKey = `${channelId}:${sourceMessageId}`;
    if (this.loggedSourceMessages.has(dedupeKey)) {
      return null;
    }

    const trajectory = this.latestTrajectories.get(channelId);
    if (!trajectory) return null;

    const now = this.now();
    if (now - trajectory.capturedAt > this.trajectoryMaxAgeMs) {
      return null;
    }

    const entry = this.failureLogStore.append({
      channelId,
      sourceMessageId,
      indicator: signal.indicator,
      assistantResponse: input.assistantResponse,
      originalContext: trajectory.originalContext,
      compressedContext: trajectory.compressedContext,
      guidelineVersion: trajectory.guidelineVersion,
      compactionCapturedAt: trajectory.capturedAt,
      detectedAt: now,
    });
    this.loggedSourceMessages.add(dedupeKey);
    return entry;
  }

  async runPeriodicGuidelineUpdate(llmProvider: LLMProvider): Promise<CompressionGuidelineUpdateResult> {
    const current = this.guidelineStore.load();
    const failures = this.failureLogStore.listSince(
      current.lastReviewedFailureAt ?? 0,
      { limit: this.failureReviewLimit },
    );
    if (failures.length === 0) {
      return {
        status: 'skipped',
        reviewedFailureCount: 0,
        reason: 'no_new_failures',
      };
    }
    if (failures.length < this.minimumFailuresForUpdate) {
      return {
        status: 'skipped',
        reviewedFailureCount: failures.length,
        reason: 'insufficient_failures',
      };
    }

    const systemPrompt = [
      'You are revising a conversation compression guideline based on observed compression failures.',
      'Return only JSON with this shape: {"updatedGuideline":"..."}',
      'Do not include markdown fences or extra keys.',
      'The updated guideline must stay concise and operational.',
    ].join('\n');
    const userPayload = JSON.stringify({
      currentGuideline: current.guideline,
      failures: failures.map(entry => ({
        indicator: entry.indicator,
        assistantResponse: entry.assistantResponse,
        compressedContext: entry.compressedContext,
        originalContext: entry.originalContext,
      })),
      failureSummary: summarizeFailuresForPrompt(failures),
    }, null, 2);

    const response = await llmProvider.complete(
      {
        systemPrompt,
        messages: [{ role: 'user', content: userPayload }],
      },
      'context',
    );
    const proposal = parseGuidelineUpdateProposal(response.content);
    const updatedGuideline = normalizeGuidelineText(proposal.updatedGuideline);
    if (!updatedGuideline) {
      throw new Error('Guideline update proposal produced empty updatedGuideline');
    }

    const reviewedFailureAt = Math.max(...failures.map(entry => entry.detectedAt));
    if (updatedGuideline === current.guideline) {
      this.guidelineStore.save({
        ...current,
        lastReviewedFailureAt: reviewedFailureAt,
      });
      return {
        status: 'skipped',
        reviewedFailureCount: failures.length,
        reason: 'no_guideline_change',
      };
    }

    const next: CompressionGuidelineRecord = {
      version: current.version + 1,
      updatedAt: new Date(this.now()).toISOString(),
      guideline: updatedGuideline,
      lastReviewedFailureAt: reviewedFailureAt,
    };
    const saved = this.guidelineStore.save(next);
    return {
      status: 'updated',
      reviewedFailureCount: failures.length,
      version: saved.version,
    };
  }
}
