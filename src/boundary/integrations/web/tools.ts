import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateAgentTool } from '../../../shared/contracts/agent-tools.js';
import type { WebFetchLane } from '../../gateway/protocol.js';
import type { WebFetchOperations } from './ops.js';
import { textResult, textResultFromError } from '../../../core/tools/results.js';
import { planWebSearchUrls, type WebSearchQueryJson } from './search.js';

const WEB_FETCH_LANES = ['default', 'local_crawler', 'discovery'] as const;
const WEB_ACTIONS = ['fetch', 'browse', 'search'] as const;

type WebAction = (typeof WEB_ACTIONS)[number];

function normalizeAction(value: unknown): WebAction {
  const action = typeof value === 'string' ? value.trim() : '';
  if (action.length === 0) {
    return 'fetch';
  }
  if ((WEB_ACTIONS as readonly string[]).includes(action)) {
    return action as WebAction;
  }
  throw new Error(`action is required. Supported actions: ${WEB_ACTIONS.join(', ')}.`);
}

function requireTarget(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('target is required.');
  }
  return value.trim();
}

function normalizePrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatSearchResults(
  query: string,
  results: Array<{ url: string; content: string }>,
): string {
  return JSON.stringify({
    action: 'search',
    query,
    count: results.length,
    results,
  }, null, 2);
}

function normalizeSearchMaxResults(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Web backend selection (bead psfn-framework-htm9.10). Explicit config chooses
 * how the search action discovers sources: `openrouter` uses the gateway
 * web.search server-tool path; `self_hosted` keeps the LLM planner + fetch loop.
 */
export type WebToolBackend = 'self_hosted' | 'openrouter';

export function createWebTool(
  ops: WebFetchOperations,
  searchQueryJson?: WebSearchQueryJson,
  backend: WebToolBackend = 'self_hosted',
): SubstrateAgentTool {
  return {
    name: 'web',
    label: 'web',
    description:
      'Unified web primitive for direct remote page work. Use action=fetch for ordinary pages, '
      + 'action=browse for the explicit local_crawler lane, and action=search for lightweight web research discovery.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(
        WEB_ACTIONS.map((value) => Type.Literal(value)),
        {
          description: 'Web action. Defaults to fetch.',
        },
      )),
      target: Type.Optional(Type.String({
        description: 'Absolute URL for fetch/browse, or a research query for search.',
      })),
      prompt: Type.Optional(Type.String({
        description: 'Optional extraction hint for fetch/browse. Usually leave unset unless you need a focused read.',
      })),
      max_urls: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 5,
        description: 'Search only: max URLs to fetch (default 3, max 5).',
      })),
    }),
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = normalizeAction(rawParams.action);
        const target = requireTarget(rawParams.target);
        const prompt = normalizePrompt(rawParams.prompt);

        switch (action) {
          case 'fetch':
            return textResult(await ops.fetch(target, {
              ...(prompt ? { prompt } : {}),
            }));
          case 'browse':
            return textResult(await ops.fetch(target, {
              lane: 'local_crawler',
              ...(prompt ? { prompt } : {}),
            }));
          case 'search': {
            // Explicit backend selection — no silent fallback between paths.
            if (backend === 'openrouter') {
              if (!ops.search) {
                throw new Error('search action unavailable: gateway web search is not wired');
              }
              const maxResults = normalizeSearchMaxResults(rawParams.max_urls);
              const result = await ops.search(target, maxResults !== undefined ? { maxResults } : {});
              const citations = result.citations.length > 0
                ? `\n\nCitations:\n${result.citations.map((url) => `- ${url}`).join('\n')}`
                : '';
              return textResult(`${result.content}${citations}`);
            }
            if (!searchQueryJson) {
              throw new Error('search action unavailable: web search planner is not configured');
            }
            const urls = await planWebSearchUrls(target, rawParams.max_urls, searchQueryJson);
            const results: Array<{ url: string; content: string }> = [];
            for (const url of urls) {
              results.push({
                url,
                content: await ops.fetch(url, {
                  lane: 'local_crawler',
                  prompt: `Research query: ${target}`,
                }),
              });
            }
            return textResult(formatSearchResults(target, results));
          }
        }
      } catch (error) {
        return textResultFromError('web failed', error);
      }
    },
  };
}

export function createWebFetchTool(ops: WebFetchOperations): SubstrateAgentTool {
  return {
    name: 'web_fetch',
    label: 'web_fetch',
    description:
      'Fetch and sanitize webpage content directly through the guarded gateway web.fetch path. Use this for routine docs/pages/articles instead of analysis_workbench.',
    parameters: Type.Object({
      url: Type.String({
        description: 'Absolute URL to fetch.',
      }),
      lane: Type.Optional(Type.Union(
        WEB_FETCH_LANES.map((value) => Type.Literal(value)),
        {
          description:
            'Optional fetch lane. Leave unset for normal web pages. Use local_crawler only when the local crawler lane is explicitly needed.',
        },
      )),
      prompt: Type.Optional(Type.String({
        description:
          'Optional extraction hint for the fetch backend. Usually leave unset unless you need a focused read.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { url: string; lane?: WebFetchLane; prompt?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        return textResult(await ops.fetch(params.url, {
          ...(params.lane ? { lane: params.lane } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
        }));
      } catch (error) {
        return textResultFromError('web_fetch failed', error);
      }
    },
  };
}
