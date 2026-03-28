import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { WebFetchLane } from '../gateway/protocol.js';
import type { WebFetchOperations } from './ops.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const WEB_FETCH_LANES = ['default', 'local_crawler', 'discovery'] as const;

export function createWebFetchTool(ops: WebFetchOperations): AgentTool<any> {
  return {
    name: 'web_fetch',
    label: 'web_fetch',
    description:
      'Fetch and sanitize webpage content directly through the guarded gateway web.fetch path. Use this for routine docs/pages/articles instead of think.',
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
        return textResultWithError(`web_fetch failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
