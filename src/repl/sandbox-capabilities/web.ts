import type { ThinkEvidence } from '../types.js';
import type { GatewayREPLCapabilities } from './contracts.js';
import { addEvidence, normalizeErrorMessage } from './common.js';

export interface WebCapabilities {
  crawler_fetch: (url: string, prompt?: string) => Promise<string>;
  web_research: (query: string, maxUrls?: number) => Promise<Array<{ url: string; content: string }>>;
}

interface CreateWebCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  pushEvidence: (entry: ThinkEvidence) => void;
  llm_query_json: (prompt: string, maxRetries?: number) => Promise<unknown>;
}

export function createWebCapabilities(options: CreateWebCapabilitiesOptions): WebCapabilities {
  const crawler_fetch = async (url: string, prompt?: string): Promise<string> => {
    if (typeof options.gatewayCaps.webFetch !== 'function') {
      return '[Web fetch unavailable: requires gateway web.fetch policy and audit path]';
    }

    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) {
      return '[Web fetch error: URL is required]';
    }

    try {
      const content = await options.gatewayCaps.webFetch(trimmed, prompt);
      addEvidence(options.pushEvidence, {
        source: 'web_fetch',
        query: trimmed,
        snippet: content,
      });
      return content;
    } catch (err) {
      return `[Web fetch error: ${normalizeErrorMessage(err)}]`;
    }
  };

  const web_research = async (
    query: string,
    maxUrls = 3,
  ): Promise<Array<{ url: string; content: string }>> => {
    const requested = Number.isFinite(maxUrls)
      ? Math.max(1, Math.min(5, Math.floor(maxUrls)))
      : 3;

    const planned = await options.llm_query_json(
      `Find up to ${requested} high-signal URLs for this research query: "${query}". ` +
      'Return ONLY a JSON array of absolute HTTPS URLs.',
      2,
    );

    const urlCandidates = Array.isArray(planned)
      ? planned.filter((item): item is string => typeof item === 'string')
      : [];

    const uniqueUrls = [...new Set(urlCandidates.map(url => url.trim()).filter(Boolean))]
      .filter(url => /^https:\/\//i.test(url))
      .slice(0, requested);

    const results: Array<{ url: string; content: string }> = [];
    for (const url of uniqueUrls) {
      const content = await crawler_fetch(url, `Research query: ${query}`);
      results.push({ url, content });
    }
    return results;
  };

  return {
    crawler_fetch,
    web_research,
  };
}
