import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { appendJsonLine, readJsonLines } from '../../persistence/jsonl.js';
import { sanitizeChannelId } from '../../persistence/sessions/store-primitives.js';

const log = createComponentLogger('SessionContinuityArtifacts');
const CONTINUITY_SUMMARY_MAX_CHARS = 800;
const CONTINUITY_NEXT_ANCHOR_MAX_CHARS = 240;

export const SESSION_CONTINUITY_ARTIFACT_KINDS = [
  'checkpoint',
  'wake_return',
] as const;
export const SESSION_CONTINUITY_FACETS = [
  'task',
  'relational',
  'life',
] as const;
export const SESSION_CONTINUITY_OCCASIONS = [
  'wake',
  'return',
] as const;

export type SessionContinuityArtifactKind = (typeof SESSION_CONTINUITY_ARTIFACT_KINDS)[number];
export type SessionContinuityFacet = (typeof SESSION_CONTINUITY_FACETS)[number];
export type SessionContinuityOccasion = (typeof SESSION_CONTINUITY_OCCASIONS)[number];

export interface SessionContinuityArtifactInput {
  sessionId: string;
  kind: SessionContinuityArtifactKind;
  summary: string;
  createdAt?: string;
  nextAnchor?: string;
  facets?: readonly SessionContinuityFacet[];
  occasion?: SessionContinuityOccasion;
}

export interface SessionContinuityArtifact {
  id: string;
  sessionId: string;
  kind: SessionContinuityArtifactKind;
  summary: string;
  createdAt: string;
  nextAnchor?: string;
  facets: SessionContinuityFacet[];
  occasion?: SessionContinuityOccasion;
}

export interface SessionContinuityArtifactListOptions {
  limit?: number;
  kind?: SessionContinuityArtifactKind;
}

const CONTINUITY_KIND_SET = new Set<string>(SESSION_CONTINUITY_ARTIFACT_KINDS);
const CONTINUITY_FACET_SET = new Set<string>(SESSION_CONTINUITY_FACETS);
const CONTINUITY_OCCASION_SET = new Set<string>(SESSION_CONTINUITY_OCCASIONS);

function normalizeRequiredText(value: unknown, field: string, maxChars = CONTINUITY_SUMMARY_MAX_CHARS): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`${field} must be at most ${String(maxChars)} characters`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredText(value, field, maxChars);
}

function normalizeCreatedAt(value: unknown): string {
  const normalized = normalizeRequiredText(value, 'createdAt', 64);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error('createdAt must be an ISO-8601 timestamp');
  }
  return normalized;
}

function normalizeKind(value: unknown): SessionContinuityArtifactKind {
  const normalized = normalizeRequiredText(value, 'kind', 32);
  if (!CONTINUITY_KIND_SET.has(normalized)) {
    throw new Error(`kind must be one of: ${SESSION_CONTINUITY_ARTIFACT_KINDS.join(', ')}`);
  }
  return normalized as SessionContinuityArtifactKind;
}

function normalizeOccasion(value: unknown): SessionContinuityOccasion {
  const normalized = normalizeRequiredText(value, 'occasion', 32);
  if (!CONTINUITY_OCCASION_SET.has(normalized)) {
    throw new Error(`occasion must be one of: ${SESSION_CONTINUITY_OCCASIONS.join(', ')}`);
  }
  return normalized as SessionContinuityOccasion;
}

function normalizeFacets(value: unknown): SessionContinuityFacet[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('facets must be an array when provided');
  }

  const deduped: SessionContinuityFacet[] = [];
  const seen = new Set<SessionContinuityFacet>();
  for (const [index, candidate] of value.entries()) {
    const normalized = normalizeRequiredText(candidate, `facets[${String(index)}]`, 32);
    if (!CONTINUITY_FACET_SET.has(normalized)) {
      throw new Error(`facets[${String(index)}] must be one of: ${SESSION_CONTINUITY_FACETS.join(', ')}`);
    }
    const facet = normalized as SessionContinuityFacet;
    if (seen.has(facet)) continue;
    seen.add(facet);
    deduped.push(facet);
  }
  return deduped;
}

function normalizeEntry(raw: unknown): SessionContinuityArtifact | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Partial<SessionContinuityArtifact>;
  try {
    const sessionId = normalizeRequiredText(entry.sessionId, 'sessionId', 512);
    const kind = normalizeKind(entry.kind);
    const createdAt = normalizeCreatedAt(entry.createdAt);
    const summary = normalizeRequiredText(entry.summary, 'summary');
    const nextAnchor = normalizeOptionalText(
      entry.nextAnchor,
      'nextAnchor',
      CONTINUITY_NEXT_ANCHOR_MAX_CHARS,
    );
    const facets = normalizeFacets(entry.facets);
    const occasion = entry.occasion === undefined ? undefined : normalizeOccasion(entry.occasion);
    if (kind === 'wake_return' && !occasion) {
      return null;
    }
    if (kind !== 'wake_return' && occasion) {
      return null;
    }

    return {
      id: normalizeRequiredText(entry.id, 'id', 128),
      sessionId,
      kind,
      summary,
      createdAt,
      facets,
      ...(nextAnchor ? { nextAnchor } : {}),
      ...(occasion ? { occasion } : {}),
    };
  } catch {
    return null;
  }
}

function compareArtifactsByRecency(
  left: SessionContinuityArtifact,
  right: SessionContinuityArtifact,
): number {
  const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (timeDelta !== 0) return timeDelta;
  return right.id.localeCompare(left.id);
}

export class SessionContinuityArtifactStore {
  constructor(private readonly artifactsDir: string) {}

  append(input: SessionContinuityArtifactInput): SessionContinuityArtifact {
    const kind = normalizeKind(input.kind);
    const nextAnchor = normalizeOptionalText(
      input.nextAnchor,
      'nextAnchor',
      CONTINUITY_NEXT_ANCHOR_MAX_CHARS,
    );
    const entry: SessionContinuityArtifact = {
      id: `continuity-${Date.now()}-${randomUUID().slice(0, 8)}`,
      sessionId: normalizeRequiredText(input.sessionId, 'sessionId', 512),
      kind,
      summary: normalizeRequiredText(input.summary, 'summary'),
      createdAt: input.createdAt ? normalizeCreatedAt(input.createdAt) : new Date().toISOString(),
      facets: normalizeFacets(input.facets),
      ...(nextAnchor ? { nextAnchor } : {}),
    };

    if (kind === 'wake_return') {
      entry.occasion = normalizeOccasion(input.occasion);
    } else if (input.occasion !== undefined) {
      throw new Error('occasion is only allowed for wake_return artifacts');
    }

    appendJsonLine(this.resolveFilePath(entry.sessionId), entry);
    log.debug('Persisted session continuity artifact', {
      sessionId: entry.sessionId,
      kind: entry.kind,
      occasion: entry.occasion,
      facetCount: entry.facets.length,
    });
    return entry;
  }

  listRecent(
    sessionId: string,
    options: SessionContinuityArtifactListOptions = {},
  ): SessionContinuityArtifact[] {
    const normalizedSessionId = normalizeRequiredText(sessionId, 'sessionId', 512);
    const filePath = this.resolveFilePath(normalizedSessionId);
    let artifacts = readJsonLines(filePath, normalizeEntry, {
      onError: ({ line, error }) => {
        log.warn('Skipping unreadable session continuity artifact line', {
          sessionId: normalizedSessionId,
          line,
          error: String(error),
        });
      },
    }).entries
      .filter(entry => entry.sessionId === normalizedSessionId)
      .sort(compareArtifactsByRecency);

    if (options.kind) {
      const kind = normalizeKind(options.kind);
      artifacts = artifacts.filter(entry => entry.kind === kind);
    }

    if (options.limit === undefined || options.limit < 1) {
      return artifacts;
    }
    return artifacts.slice(0, Math.floor(options.limit));
  }

  private resolveFilePath(sessionId: string): string {
    return join(this.artifactsDir, `${sanitizeChannelId(sessionId)}.jsonl`);
  }
}
