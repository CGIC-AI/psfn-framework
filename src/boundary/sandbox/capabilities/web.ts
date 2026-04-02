import type { ThinkEvidence } from '../../../core/tools/think/types.js';
import type { GatewayREPLCapabilities, SandboxBudgetRef } from './contracts.js';
import {
  addEvidence,
  consumeToolCallBudget,
  normalizeErrorMessage,
  TOOL_CALL_BUDGET_EXCEEDED_MESSAGE,
} from './common.js';

export interface WebCapabilities {
  web(
    action: 'fetch' | 'browse',
    target: string,
    options?: { prompt?: string },
  ): Promise<string>;
  web(
    action: 'search',
    target: string,
    options?: { maxUrls?: number },
  ): Promise<Array<{ url: string; content: string }>>;
}

interface CreateWebCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  pushEvidence: (entry: ThinkEvidence) => void;
  budgetRef?: SandboxBudgetRef;
  llm_query_json: (prompt: string, maxRetries?: number) => Promise<unknown>;
}

export function createWebCapabilities(options: CreateWebCapabilitiesOptions): WebCapabilities {
  const fetchViaLane = async (
    url: string,
    lane: 'default' | 'local_crawler',
    labels: {
      unavailable: string;
      missingTarget: string;
      failurePrefix: string;
    },
    prompt?: string,
  ): Promise<string> => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return `[${labels.failurePrefix}: ${TOOL_CALL_BUDGET_EXCEEDED_MESSAGE}]`;
    }

    if (typeof options.gatewayCaps.webFetch !== 'function') {
      return `[${labels.unavailable}]`;
    }

    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) {
      return `[${labels.missingTarget}]`;
    }

    try {
      const content = await options.gatewayCaps.webFetch(trimmed, prompt, lane);
      addEvidence(options.pushEvidence, {
        source: 'web_fetch',
        query: trimmed,
        snippet: content,
      });
      return content;
    } catch (err) {
      return `[${labels.failurePrefix}: ${normalizeErrorMessage(err)}]`;
    }
  };

  const searchWeb = async (
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
      const content = await fetchViaLane(
        url,
        'local_crawler',
        {
          unavailable: 'Web browse unavailable: requires gateway web.fetch policy and audit path',
          missingTarget: 'Web browse error: URL is required',
          failurePrefix: 'Web browse error',
        },
        `Research query: ${query}`,
      );
      results.push({ url, content });
    }
    return results;
  };

  async function web(
    action: 'fetch' | 'browse',
    target: string,
    options?: { prompt?: string },
  ): Promise<string>;
  async function web(
    action: 'search',
    target: string,
    options?: { maxUrls?: number },
  ): Promise<Array<{ url: string; content: string }>>;
  async function web(
    action: 'fetch' | 'browse' | 'search',
    target: string,
    options?: { prompt?: string; maxUrls?: number },
  ): Promise<string | Array<{ url: string; content: string }>> {
    switch (action) {
      case 'fetch':
        return await fetchViaLane(
          target,
          'default',
          {
            unavailable: 'Web fetch unavailable: requires gateway web.fetch policy and audit path',
            missingTarget: 'Web fetch error: URL is required',
            failurePrefix: 'Web fetch error',
          },
          options?.prompt,
        );
      case 'browse':
        return await fetchViaLane(
          target,
          'local_crawler',
          {
            unavailable: 'Web browse unavailable: requires gateway web.fetch policy and audit path',
            missingTarget: 'Web browse error: URL is required',
            failurePrefix: 'Web browse error',
          },
          options?.prompt,
        );
      case 'search':
        return await searchWeb(target, options?.maxUrls);
      default:
        return [`[Web error: unsupported action "${String(action)}"]`].join('');
    }
  }

  return {
    web,
  };
}
