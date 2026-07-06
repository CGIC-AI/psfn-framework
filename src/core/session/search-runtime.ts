import type { LLMProviderPort } from '../agent/contracts.js';
import type { SessionEntry } from './types.js';
import type { SourceChannelSessionRoute, SessionRouteResetMode } from './session-routes.js';
import { classifyChannelDisclosure, getAllowedSensitivities } from '../../system/trust/policy.js';
import type { SensitivityLevel, TrustLevel } from '../../system/trust/types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import { decodeStoredChannelVisibility } from '../../system/trust/types.js';
import type { TranscriptSearchPort } from '../../persistence/sessions/transcript-search-port.js';
import { isCogSecTombstoneSessionEntry } from '../cogsec/tombstones.js';
import { SESSION_SEARCH_SUMMARY_PROMPT_KEY } from '../identity/prompt-registry.js';
import type { PromptRegistryStatePort } from '../identity/prompt-state-port.js';
import { completeSessionSummary } from './manager/compaction-service.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const log = createComponentLogger('SessionSearch');

const DEFAULT_SESSION_SEARCH_LIMIT = 8;
const MAX_SESSION_SEARCH_LIMIT = 25;
const SESSION_SEARCH_OVERSAMPLE_FACTOR = 4;
const SESSION_SEARCH_MAX_SUMMARY_MATCHES = 10;
const SESSION_SEARCH_MAX_SUMMARY_CONTEXT_CHARS = 4000;
const SESSION_SEARCH_MAX_SNIPPET_CHARS = 220;
/** Correlation channel label when a search is not scoped to one channel. */
const SESSION_SEARCH_CORRELATION_CHANNEL = 'session-search';

export interface SessionSearchViewerContext {
  channelId?: string;
  isDirectMessage?: boolean;
  trustLevel?: TrustLevel;
  channelVisibility?: ChannelPrivacy;
}

export interface SessionSearchRouteLabel {
  sourceChannelId: string;
  activeLogicalSessionId: string;
  status: 'active' | 'retired';
  mode?: SessionRouteResetMode;
  retiredAt?: string;
}

export interface SessionSearchRouteStateProvider {
  getRouteForLogicalSession?(logicalSessionId: string): SourceChannelSessionRoute | null | undefined;
  getSessionRouteForLogicalSession?(logicalSessionId: string): SourceChannelSessionRoute | null | undefined;
}

export interface SessionSearchHitResult {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  timestamp: number;
  channelVisibility: ChannelPrivacy;
  score: number;
  snippet: string;
  sessionRoute?: SessionSearchRouteLabel;
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
): ChannelPrivacy {
  // Search hits come from persisted projections that may predate the E3.1
  // rename / E3.3 broadcast split; the shared decoder maps the retired
  // vocabulary onto ChannelPrivacy.
  return decodeStoredChannelVisibility(input) ?? classifyChannelDisclosure(channelId).channelPrivacy;
}

function visibilityToSensitivity(visibility: ChannelPrivacy): SensitivityLevel {
  switch (visibility) {
    case 'private':
      return 'confidential';
    case 'invite_only':
      return 'personal';
    case 'public':
      return 'public';
  }
}

export function resolveSessionSearchViewerVisibility(
  viewer: SessionSearchViewerContext | undefined,
): ChannelPrivacy {
  if (viewer?.channelVisibility) {
    return viewer.channelVisibility;
  }
  if (viewer?.channelId) {
    return classifyChannelDisclosure(viewer.channelId, {
      isDirectMessage: viewer.isDirectMessage,
    }).channelPrivacy;
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
    getAllowedSensitivities(trustLevel, { channelPrivacy: viewerVisibility, broadcast: false }),
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
    const routeLabel = hit.sessionRoute
      ? ` route_status=${hit.sessionRoute.status} source_channel=${hit.sessionRoute.sourceChannelId}`
      : '';
    const line = `- [${timestampIso}] channel=${hit.channelId} role=${hit.role} visibility=${hit.channelVisibility}${routeLabel} score=${hit.score.toFixed(3)} snippet=${truncateSessionSearchSnippet(hit.snippet)}`;
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

export function resolveSessionSearchRouteLabel(
  routeState: SessionSearchRouteStateProvider | null | undefined,
  logicalSessionId: string,
): SessionSearchRouteLabel | undefined {
  const route = routeState?.getSessionRouteForLogicalSession?.(logicalSessionId)
    ?? routeState?.getRouteForLogicalSession?.(logicalSessionId);
  if (!route) return undefined;
  if (route.activeLogicalSessionId === logicalSessionId) {
    return {
      sourceChannelId: route.sourceChannelId,
      activeLogicalSessionId: route.activeLogicalSessionId,
      status: 'active',
      mode: route.mode,
    };
  }
  const retired = route.retiredSessions.find(entry => entry.logicalSessionId === logicalSessionId);
  if (!retired) return undefined;
  return {
    sourceChannelId: route.sourceChannelId,
    activeLogicalSessionId: route.activeLogicalSessionId,
    status: 'retired',
    mode: retired.mode,
    retiredAt: retired.retiredAt,
  };
}

async function summarizeSessionSearch(params: {
  llmProvider: LLMProviderPort | null | undefined;
  promptRegistry: PromptRegistryStatePort | null;
  channelId: string;
  query: string;
  hits: SessionSearchHitResult[];
}): Promise<string> {
  const fallback = fallbackSessionSearchSummary(params.query, params.hits);
  if (params.hits.length === 0 || !params.llmProvider) return fallback;

  const payload = buildSessionSearchSummaryPayload(params.query, params.hits);
  const requestContext = getRequestContext();
  const requestIdBase = requestContext?.requestId
    ? `${requestContext.requestId}:search-summary`
    : `search-summary:${params.channelId}:${Date.now()}`;
  try {
    // Shared session-summary completion path: PromptRegistry-owned prompt,
    // runtime-token injection, retry, and correlation metadata all live in
    // completeSessionSummary (see compaction-service.ts).
    const summary = await completeSessionSummary({
      channelId: params.channelId,
      sourceText: payload,
      llmProvider: params.llmProvider,
      promptRegistry: params.promptRegistry,
      promptKey: SESSION_SEARCH_SUMMARY_PROMPT_KEY,
      requestIdBase,
      correlationPurpose: 'session.search.summary',
      originStage: 'session.search.summary',
      maxRetries: 1,
      baseDelayMs: 150,
    });
    const normalized = summary.replace(/\s+/g, ' ').trim();
    return normalized || fallback;
  } catch (error) {
    // Non-blocking by contract: search results still return with the
    // deterministic fallback summary, but the failure is never silent.
    log.warn('Session search summary failed; using deterministic fallback', {
      channelId: params.channelId,
      query: params.query,
      hitCount: params.hits.length,
      error: toErrorMessage(error),
    });
    return fallback;
  }
}

export async function runSessionSearch(params: {
  transcriptSearch: TranscriptSearchPort | null | undefined;
  llmProvider?: LLMProviderPort | null;
  promptRegistry?: PromptRegistryStatePort | null;
  query: string;
  limit?: number;
  summarize?: boolean;
  targetChannelId?: string;
  viewer?: SessionSearchViewerContext;
  sessionRouteState?: SessionSearchRouteStateProvider | null;
}): Promise<SessionSearchResult> {
  const normalizedQuery = params.query.trim();
  if (!normalizedQuery || !params.transcriptSearch) {
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
  const rawHits = await params.transcriptSearch.searchByKeywords(
    normalizedQuery,
    requestedLimit * SESSION_SEARCH_OVERSAMPLE_FACTOR,
  );
  const nonTombstoneHits = rawHits.filter(hit => !isCogSecTombstoneSessionEntry(hit));
  const scopedHits = scopedChannelId
    ? nonTombstoneHits.filter(hit => hit.channelId === scopedChannelId)
    : nonTombstoneHits;
  const filteredHits = scopedHits.filter(hit => canViewerAccessSessionHit(params.viewer, hit));

  const hits: SessionSearchHitResult[] = filteredHits
    .slice(0, requestedLimit)
    .map(hit => {
      const visibility = resolveSessionSearchHitVisibility(hit.channelVisibility, hit.channelId);
      const sessionRoute = resolveSessionSearchRouteLabel(params.sessionRouteState, hit.channelId);
      return {
        channelId: hit.channelId,
        messageId: hit.messageId,
        role: hit.role,
        timestamp: hit.timestamp,
        channelVisibility: visibility,
        score: hit.score,
        snippet: truncateSessionSearchSnippet(hit.snippet || hit.content),
        ...(sessionRoute ? { sessionRoute } : {}),
      };
    });

  const summary = params.summarize
    ? await summarizeSessionSearch({
      llmProvider: params.llmProvider,
      promptRegistry: params.promptRegistry ?? null,
      channelId: scopedChannelId ?? params.viewer?.channelId ?? SESSION_SEARCH_CORRELATION_CHANNEL,
      query: normalizedQuery,
      hits,
    })
    : fallbackSessionSearchSummary(normalizedQuery, hits);

  return {
    query: normalizedQuery,
    summary,
    totalHits: scopedHits.length,
    gatedOutCount: Math.max(0, scopedHits.length - filteredHits.length),
    hits,
  };
}
