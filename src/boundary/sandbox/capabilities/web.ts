import type { ThinkEvidence } from '../../../repl/types.js';
import type { GatewayREPLCapabilities, SandboxBudgetRef } from './contracts.js';
import {
  addEvidence,
  consumeToolCallBudget,
  normalizeErrorMessage,
  TOOL_CALL_BUDGET_EXCEEDED_MESSAGE,
} from './common.js';

export interface WebCapabilities {
  web_fetch: (url: string, prompt?: string) => Promise<string>;
  crawler_fetch: (url: string, prompt?: string) => Promise<string>;
  web_research: (query: string, maxUrls?: number) => Promise<Array<{ url: string; content: string }>>;
}

interface CreateWebCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  pushEvidence: (entry: ThinkEvidence) => void;
  budgetRef?: SandboxBudgetRef;
  llm_query_json: (prompt: string, maxRetries?: number) => Promise<unknown>;
}

export function createWebCapabilities(options: CreateWebCapabilitiesOptions): WebCapabilities {
  const web_fetch = async (url: string, prompt?: string): Promise<string> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return `[Web fetch error: ${TOOL_CALL_BUDGET_EXCEEDED_MESSAGE}]`;
    }

    if (typeof options.gatewayCaps.webFetch !== 'function') {
      return '[Web fetch unavailable: requires gateway web.fetch policy and audit path]';
    }

    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) {
      return '[Web fetch error: URL is required]';
    }

    try {
      const content = await options.gatewayCaps.webFetch(trimmed, prompt, 'default');
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

  const crawler_fetch = async (url: string, prompt?: string): Promise<string> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return `[Crawler fetch error: ${TOOL_CALL_BUDGET_EXCEEDED_MESSAGE}]`;
    }

    if (typeof options.gatewayCaps.webFetch !== 'function') {
      return '[Crawler fetch unavailable: requires gateway web.fetch policy and audit path]';
    }

    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) {
      return '[Crawler fetch error: URL is required]';
    }

    try {
      const content = await options.gatewayCaps.webFetch(trimmed, prompt, 'local_crawler');
      addEvidence(options.pushEvidence, {
        source: 'web_fetch',
        query: trimmed,
        snippet: content,
      });
      return content;
    } catch (err) {
      return `[Crawler fetch error: ${normalizeErrorMessage(err)}]`;
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
    web_fetch,
    crawler_fetch,
    web_research,
  };
}
