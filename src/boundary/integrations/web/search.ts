import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';

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

export function createWebSearchQueryJson(llmProvider: LLMProviderPort): WebSearchQueryJson {
  return async (prompt: string, maxRetries?: number): Promise<unknown> => {
    const requestContext = getRequestContext();
    const retries = typeof maxRetries === 'number' && Number.isFinite(maxRetries)
      ? Math.max(1, Math.floor(maxRetries))
      : 2;

    for (let attempt = 1; attempt <= retries; attempt++) {
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
        return JSON.parse(response.content);
      } catch {
        if (attempt === retries) {
          return null;
        }
      }
    }

    return null;
  };
}
