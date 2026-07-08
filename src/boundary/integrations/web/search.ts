import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { withRetry } from '../../../primitives/llm/retry.js';

const DEFAULT_WEB_SEARCH_MAX_URLS = 3;
const MAX_WEB_SEARCH_URLS = 5;

export type WebSearchQueryJson = (prompt: string, maxRetries?: number) => Promise<unknown>;

export function normalizeWebSearchLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WEB_SEARCH_MAX_URLS;
  }
  return Math.max(1, Math.min(MAX_WEB_SEARCH_URLS, Math.floor(value)));
}

export async function planWebSearchUrls(
  query: string,
  maxUrls: unknown,
  queryJson: WebSearchQueryJson,
): Promise<string[]> {
  const requested = normalizeWebSearchLimit(maxUrls);
  const planned = await queryJson(
    `Find up to ${requested} high-signal URLs for this research query: "${query}". `
    + 'Return ONLY a JSON array of absolute HTTPS URLs.',
    2,
  );

  const urlCandidates = Array.isArray(planned)
    ? planned.filter((item): item is string => typeof item === 'string')
    : [];

  return [...new Set(urlCandidates.map(url => url.trim()).filter(Boolean))]
    .filter(url => /^https:\/\//i.test(url))
    .slice(0, requested);
}

/**
 * Marks a completion whose content was not valid JSON. Only this failure mode
 * is retryable for web-search planning; thrown provider/network errors
 * propagate unretried on any attempt.
 */
class WebSearchJsonParseError extends Error {
  constructor(cause: unknown) {
    super('web search completion returned invalid JSON', { cause });
    this.name = 'WebSearchJsonParseError';
  }
}

export function createWebSearchQueryJson(llmProvider: LLMProviderPort): WebSearchQueryJson {
  return async (prompt: string, maxRetries?: number): Promise<unknown> => {
    const requestContext = getRequestContext();
    // Callers pass the total attempt budget (historical contract of this
    // surface); the shared retry primitive counts retries after the first try.
    const totalAttempts = typeof maxRetries === 'number' && Number.isFinite(maxRetries)
      ? Math.max(1, Math.floor(maxRetries))
      : 2;

    let attempt = 0;
    try {
      return await withRetry(
        async () => {
          attempt += 1;
          const response = await llmProvider.complete(
            {
              systemPrompt: 'You are a precise web research planner. Return valid JSON only.',
              messages: [{
                role: 'user',
                content: `${prompt}\n\nRespond with valid JSON only, no markdown.`,
              }],
              correlation: {
                ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
                ...(requestContext?.channelId ? { channelId: requestContext.channelId } : {}),
                requestId: requestContext?.requestId
                  ? `${requestContext.requestId}:web-search:${attempt}`
                  : `web-search-${Date.now()}-${attempt}`,
                callType: 'tool',
                toolName: 'web',
                purpose: attempt === 1 ? 'agent.web.search' : 'agent.web.search.retry',
                originType: 'tool',
                originStage: attempt === 1 ? 'agent.web.search' : 'agent.web.search.retry',
                ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
              },
            },
            'reasoning',
          );

          try {
            return JSON.parse(response.content) as unknown;
          } catch (error) {
            throw new WebSearchJsonParseError(error);
          }
        },
        { maxRetries: totalAttempts - 1, baseDelayMs: 0 },
        { isRetryable: (error) => error instanceof WebSearchJsonParseError },
      );
    } catch (error) {
      // Parse failures exhaust the attempt budget into a null plan; every
      // other error (provider, network, abort) propagates to the caller.
      if (error instanceof WebSearchJsonParseError) {
        return null;
      }
      throw error;
    }
  };
}
