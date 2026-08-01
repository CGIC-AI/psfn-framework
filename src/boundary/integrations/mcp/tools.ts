import { JSONRPCErrorException } from 'json-rpc-2.0';
import { Type } from '@sinclair/typebox';
import type { AgentToolResult, SubstrateAgentTool } from '../../pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import {
  GatewayErrors,
  type McpExecuteParams,
  type McpExecuteResult,
} from '../../gateway/protocol.js';

const MCP_ACTIONS = ['catalog', 'search', 'inspect', 'call', 'release'] as const;
type McpToolAction = typeof MCP_ACTIONS[number];

export interface McpToolParams {
  action: McpToolAction;
  server_id?: string;
  tool_name?: string;
  query?: string;
  limit?: number;
  arguments?: Record<string, unknown>;
}

export interface McpToolGatewayPort {
  mcpExecute(
    params: Omit<McpExecuteParams, 'permit' | 'cancellationId'>,
    options: {
      toolCallId: string;
      signal?: AbortSignal;
    },
  ): Promise<McpExecuteResult>;
}

export interface McpToolRuntime {
  gateway: McpToolGatewayPort;
}

function result(
  text: string,
  details: Record<string, unknown>,
  isError = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details: { ...details, ...(isError ? { isError: true } : {}) },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`mcp ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeParams(raw: unknown): McpToolParams {
  if (!isRecord(raw)) throw new Error('mcp params must be an object');
  if (typeof raw.action !== 'string' || !MCP_ACTIONS.includes(raw.action as McpToolAction)) {
    throw new Error(`mcp action must be one of: ${MCP_ACTIONS.join(', ')}`);
  }
  const action = raw.action as McpToolAction;
  if (action === 'catalog') {
    assertNoUnknownKeys(raw, ['action'], 'mcp catalog params');
    return { action };
  }
  if (action === 'search') {
    assertNoUnknownKeys(raw, ['action', 'query', 'limit'], 'mcp search params');
    const query = requiredString(raw.query, 'query');
    if (raw.limit !== undefined && (
      !Number.isSafeInteger(raw.limit)
      || (raw.limit as number) < 1
      || (raw.limit as number) > 20
    )) {
      throw new Error('mcp limit must be an integer between 1 and 20');
    }
    return { action, query, ...(raw.limit === undefined ? {} : { limit: raw.limit as number }) };
  }
  if (action === 'inspect') {
    assertNoUnknownKeys(raw, ['action', 'server_id', 'tool_name'], 'mcp inspect params');
    return {
      action,
      server_id: requiredString(raw.server_id, 'server_id'),
      tool_name: requiredString(raw.tool_name, 'tool_name'),
    };
  }
  if (action === 'call') {
    assertNoUnknownKeys(raw, ['action', 'server_id', 'tool_name', 'arguments'], 'mcp call params');
    if (!isRecord(raw.arguments)) throw new Error('mcp arguments must be an object');
    return {
      action,
      server_id: requiredString(raw.server_id, 'server_id'),
      tool_name: requiredString(raw.tool_name, 'tool_name'),
      arguments: raw.arguments,
    };
  }
  assertNoUnknownKeys(raw, ['action', 'server_id'], 'mcp release params');
  return {
    action,
    ...(raw.server_id === undefined ? {} : { server_id: requiredString(raw.server_id, 'server_id') }),
  };
}

function toGatewayParams(params: McpToolParams): Omit<
  McpExecuteParams,
  'permit' | 'cancellationId'
> {
  switch (params.action) {
    case 'catalog':
      return { action: 'catalog' };
    case 'search':
      return {
        action: 'search',
        query: params.query!,
        limit: params.limit ?? 8,
      };
    case 'inspect':
      return { action: 'inspect', serverId: params.server_id!, toolName: params.tool_name! };
    case 'call':
      return {
        action: 'call',
        serverId: params.server_id!,
        toolName: params.tool_name!,
        arguments: params.arguments!,
      };
    case 'release':
      return { action: 'release', ...(params.server_id ? { serverId: params.server_id } : {}) };
  }
}

function formatSuccess(response: McpExecuteResult): AgentToolResult<Record<string, unknown>> {
  switch (response.action) {
    case 'catalog':
      return result(JSON.stringify({ servers: response.servers }, null, 2), {
        mcp: { action: 'catalog', serverCount: response.servers.length },
      });
    case 'search':
      return result(JSON.stringify({ query: response.query, tools: response.tools }, null, 2), {
        mcp: { action: 'search', toolCount: response.tools.length },
      });
    case 'inspect':
      return result(JSON.stringify({
        serverId: response.serverId,
        serverDisplayName: response.serverDisplayName,
        tool: response.tool,
        policy: response.policy,
      }, null, 2), {
        mcp: {
          action: 'inspect',
          serverId: response.serverId,
          toolName: response.tool.name,
        },
      });
    case 'call':
      return result(response.effectiveText, {
        mcp: {
          action: 'call',
          serverId: response.serverId,
          toolName: response.toolName,
          withheld: response.withheld,
          remoteError: response.isError,
        },
      }, response.withheld || response.isError);
    case 'release':
      return result(
        response.serverId
          ? `Released MCP server "${response.serverId}". Its connection and loaded tool definitions were unloaded.`
          : 'Released all MCP servers for this companion. Their connections and loaded tool definitions were unloaded.',
        { mcp: { action: 'release', released: true, ...(response.serverId ? { serverId: response.serverId } : {}) } },
      );
  }
}

function formatFailure(
  action: McpToolAction | undefined,
  error: unknown,
): AgentToolResult<Record<string, unknown>> {
  if (error instanceof JSONRPCErrorException) {
    const data = isRecord(error.data) ? error.data : {};
    const approvalId = typeof data.approvalId === 'string' ? data.approvalId : undefined;
    const message = error.code === GatewayErrors.NEEDS_APPROVAL
      ? `MCP call is pending operator approval${approvalId ? ` (id: ${approvalId})` : ''}.`
      : error.message;
    return result(message, {
      mcp: {
        action: action ?? 'unknown',
        code: error.code,
        ...(approvalId ? { approvalId } : {}),
        ...(typeof data.mcpCode === 'string' ? { mcpCode: data.mcpCode } : {}),
      },
    }, true);
  }
  return result('MCP request failed at the gateway boundary.', {
    mcp: { action: action ?? 'unknown', code: 'MCP_REQUEST_FAILED' },
  }, true);
}

export function createMcpTool(runtime: McpToolRuntime): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'mcp',
    label: 'mcp',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.mcp,
    parameters: Type.Object({
      action: Type.Union(MCP_ACTIONS.map(action => Type.Literal(action)), {
        description: 'Progressive MCP action: browse servers, search summaries, inspect one schema, call it, or unload it.',
      }),
      server_id: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'Operator catalog server id. Required by inspect/call; optional on release to unload all.',
      })),
      tool_name: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 128,
        description: 'Exact tool name returned by search. Required by inspect/call.',
      })),
      query: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 512,
        description: 'Purpose/name query for search. Search returns summaries, not schemas.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 20,
        description: 'Maximum search summaries to return.',
      })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Call arguments matching the one schema returned by inspect.',
      })),
    }, { additionalProperties: false }),
    execute: async (
      toolCallId: string,
      raw: McpToolParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      let params: McpToolParams | undefined;
      try {
        params = normalizeParams(raw);
        const response = await runtime.gateway.mcpExecute(toGatewayParams(params), {
          toolCallId,
          ...(signal ? { signal } : {}),
        });
        return formatSuccess(response);
      } catch (error) {
        return formatFailure(params?.action, error);
      }
    },
  };
  return tool;
}
