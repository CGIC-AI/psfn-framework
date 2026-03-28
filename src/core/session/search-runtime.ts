import type { LLMProvider } from '../agent/contracts.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionEntry } from '../../session/types.js';
import { classifyChannel, getAllowedSensitivities } from '../../system/trust/policy.js';
import type { ChannelVisibility, SensitivityLevel, TrustLevel } from '../../system/trust/types.js';

const DEFAULT_SESSION_SEARCH_LIMIT = 8;
const MAX_SESSION_SEARCH_LIMIT = 25;
const SESSION_SEARCH_OVERSAMPLE_FACTOR = 4;
const SESSION_SEARCH_MAX_SUMMARY_MATCHES = 10;
const SESSION_SEARCH_MAX_SUMMARY_CONTEXT_CHARS = 4000;
const SESSION_SEARCH_MAX_SNIPPET_CHARS = 220;

const SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT = [
  'You summarize keyword-search matches from archived chat transcripts.',
  'Use only the provided snippets.',
  'Name key topics and channel groupings.',
  'If evidence is sparse or ambiguous, state that explicitly.',
  'Keep the answer concise (3-5 sentences).',
].join(' ');

export interface SessionSearchViewerContext {
  channelId?: string;
  isDirectMessage?: boolean;
  trustLevel?: TrustLevel;
  channelVisibility?: ChannelVisibility;
}

export interface SessionSearchHitResult {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  timestamp: number;
  channelVisibility: ChannelVisibility;
  score: number;
  snippet: string;
}

export interface SessionSearchResult {
  query: string;
  summary: string;
  totalHits: number;
  gatedOutCount: number;
  hits: SessionSearchHitResult[];
}

export function normalizeSessionSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SESSION_SEARCH_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized <= 0) return DEFAULT_SESSION_SEARCH_LIMIT;
  return Math.min(normalized, MAX_SESSION_SEARCH_LIMIT);
}

export function resolveSessionSearchViewerTrustLevel(input?: TrustLevel): TrustLevel {
  switch (input) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return input;
    default:
      return 'regular';
  }
}

export function resolveSessionSearchHitVisibility(
  input: string | undefined,
  channelId: string,
): ChannelVisibility {
  switch (input) {
    case 'private':
    case 'semi_private':
    case 'public':
    case 'broadcast':
      return input;
    default:
      return classifyChannel(channelId);
  }
}

function visibilityToSensitivity(visibility: ChannelVisibility): SensitivityLevel {
  switch (visibility) {
    case 'private':
      return 'confidential';
    case 'semi_private':
      return 'personal';
    case 'public':
    case 'broadcast':
      return 'public';
  }
}

export function resolveSessionSearchViewerVisibility(
  viewer: SessionSearchViewerContext | undefined,
): ChannelVisibility {
  if (viewer?.channelVisibility) {
    return viewer.channelVisibility;
  }
  if (viewer?.channelId) {
    return classifyChannel(viewer.channelId, {
      isDirectMessage: viewer.isDirectMessage,
    });
  }
  return 'public';
}

export function canViewerAccessSessionHit(
  viewer: SessionSearchViewerContext | undefined,
  hit: {
    channelId: string;
    channelVisibility?: string;
  },
): boolean {
  const trustLevel = resolveSessionSearchViewerTrustLevel(viewer?.trustLevel);
  const viewerVisibility = resolveSessionSearchViewerVisibility(viewer);
  const allowedSensitivities = new Set(
    getAllowedSensitivities(trustLevel, viewerVisibility),
  );
  const hitVisibility = resolveSessionSearchHitVisibility(hit.channelVisibility, hit.channelId);
  return allowedSensitivities.has(visibilityToSensitivity(hitVisibility));
}

export function truncateSessionSearchSnippet(
  content: string,
  maxChars = SESSION_SEARCH_MAX_SNIPPET_CHARS,
): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function fallbackSessionSearchSummary(query: string, hits: SessionSearchHitResult[]): string {
  if (hits.length === 0) {
    return `No transcript matches found for "${query}".`;
  }

  const channels = [...new Set(hits.map(hit => hit.channelId))];
  return `Found ${hits.length} transcript matches for "${query}" across ${channels.length} channel(s): ${channels.join(', ')}.`;
}

function buildSessionSearchSummaryPayload(
  query: string,
  hits: SessionSearchHitResult[],
): string {
  const lines = [
    `Search query: ${query}`,
    '',
    'Matched transcript snippets:',
  ];

  let budgetUsed = lines.join('\n').length;
  for (const hit of hits.slice(0, SESSION_SEARCH_MAX_SUMMARY_MATCHES)) {
    const timestampIso = new Date(hit.timestamp).toISOString();
    const line = `- [${timestampIso}] channel=${hit.channelId} role=${hit.role} visibility=${hit.channelVisibility} score=${hit.score.toFixed(3)} snippet=${truncateSessionSearchSnippet(hit.snippet)}`;
    if (budgetUsed + line.length > SESSION_SEARCH_MAX_SUMMARY_CONTEXT_CHARS) {
      break;
    }
    lines.push(line);
    budgetUsed += line.length + 1;
  }

  lines.push('');
  lines.push('Summarize what these snippets indicate and highlight the most relevant channels.');
  return lines.join('\n');
}

async function summarizeSessionSearch(
  llmProvider: LLMProvider | null | undefined,
  query: string,
  hits: SessionSearchHitResult[],
): Promise<string> {
  const fallback = fallbackSessionSearchSummary(query, hits);
  if (hits.length === 0 || !llmProvider) return fallback;

  const payload = buildSessionSearchSummaryPayload(query, hits);
  try {
    const response = await llmProvider.complete(
      {
        systemPrompt: SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
      },
      'summary',
    );
    const content = typeof response.content === 'string'
      ? response.content.replace(/\s+/g, ' ').trim()
      : '';
    return content || fallback;
  } catch {
    return fallback;
  }
}

export async function runSessionSearch(params: {
  sessionManager: Pick<SessionManager, 'searchTranscripts'> | null | undefined;
  llmProvider?: LLMProvider | null;
  query: string;
  limit?: number;
  summarize?: boolean;
  targetChannelId?: string;
  viewer?: SessionSearchViewerContext;
}): Promise<SessionSearchResult> {
  const normalizedQuery = params.query.trim();
  if (!normalizedQuery || !params.sessionManager) {
    return {
      query: normalizedQuery,
      summary: normalizedQuery
        ? `No transcript matches found for "${normalizedQuery}".`
        : 'No transcript matches found.',
      totalHits: 0,
      gatedOutCount: 0,
      hits: [],
    };
  }

  const requestedLimit = normalizeSessionSearchLimit(params.limit ?? DEFAULT_SESSION_SEARCH_LIMIT);
  const scopedChannelId = typeof params.targetChannelId === 'string' && params.targetChannelId.trim().length > 0
    ? params.targetChannelId.trim()
    : undefined;
  const rawHits = params.sessionManager.searchTranscripts(
    normalizedQuery,
    requestedLimit * SESSION_SEARCH_OVERSAMPLE_FACTOR,
  );
  const scopedHits = scopedChannelId
    ? rawHits.filter(hit => hit.channelId === scopedChannelId)
    : rawHits;
  const filteredHits = scopedHits.filter(hit => canViewerAccessSessionHit(params.viewer, hit));

  const hits: SessionSearchHitResult[] = filteredHits
    .slice(0, requestedLimit)
    .map(hit => {
      const visibility = resolveSessionSearchHitVisibility(hit.channelVisibility, hit.channelId);
      return {
        channelId: hit.channelId,
        messageId: hit.messageId,
        role: hit.role,
        timestamp: hit.timestamp,
        channelVisibility: visibility,
        score: hit.score,
        snippet: truncateSessionSearchSnippet(hit.snippet || hit.content),
      };
    });

  const summary = params.summarize
    ? await summarizeSessionSearch(params.llmProvider, normalizedQuery, hits)
    : fallbackSessionSearchSummary(normalizedQuery, hits);

  return {
    query: normalizedQuery,
    summary,
    totalHits: scopedHits.length,
    gatedOutCount: Math.max(0, scopedHits.length - filteredHits.length),
    hits,
  };
}
