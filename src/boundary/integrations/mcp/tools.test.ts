import { JSONRPCErrorException } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';
import { resolveToolRequiredCapabilities } from '../../../system/capabilities/requirements.js';
import { GatewayErrors, type McpExecuteResult } from '../../gateway/protocol.js';
import { createMcpTool, type McpToolGatewayPort } from './tools.js';

function text(result: Awaited<ReturnType<ReturnType<typeof createMcpTool>['execute']>>): string {
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}

function gateway(result?: McpExecuteResult): McpToolGatewayPort & { mcpExecute: ReturnType<typeof vi.fn> } {
  return {
    mcpExecute: vi.fn(async (params): Promise<McpExecuteResult> => result ?? (
      params.action === 'catalog'
        ? { action: 'catalog', servers: [] }
        : { action: 'release', released: true }
    )),
  };
}

describe('canonical MCP tool', () => {
  it('keeps one bounded schema and exposes no authority, credential, or sensitivity fields', () => {
    const tool = createMcpTool({ gateway: gateway() });
    const serialized = JSON.stringify(tool.parameters);

    expect(tool.name).toBe('mcp');
    expect(serialized).toContain('catalog');
    expect(serialized).toContain('search');
    expect(serialized).toContain('inspect');
    expect(serialized).toContain('call');
    expect(serialized).toContain('release');
    for (const forbidden of [
      'effectiveSensitivity', 'effective_sensitivity', 'trust', 'confirmation',
      'companionId', 'companion_id', 'credential', 'token', 'channelId', 'channel_id',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('routes discovery progressively without attaching a remote schema to the stable tool', async () => {
    const inspected: McpExecuteResult = {
      action: 'inspect',
      serverId: 'notes',
      serverDisplayName: 'Private notes',
      tool: {
        name: 'search_notes',
        description: 'Search notes.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      policy: { effect: 'read', confirmation: 'never', maxOutboundSensitivity: 'personal' },
    };
    const mcpGateway = gateway(inspected);
    const tool = createMcpTool({ gateway: mcpGateway });

    const result = await tool.execute('inspect-1', {
      action: 'inspect', server_id: 'notes', tool_name: 'search_notes',
    });

    expect(mcpGateway.mcpExecute).toHaveBeenCalledWith({
      action: 'inspect', serverId: 'notes', toolName: 'search_notes',
    }, { toolCallId: 'inspect-1' });
    expect(text(result)).toContain('inputSchema');
    expect(JSON.stringify(tool.parameters)).not.toContain('search_notes');
  });

  it('forwards only the tool-call id needed to consume gateway-minted authority', async () => {
    const mcpGateway = gateway({
      action: 'call',
      serverId: 'notes',
      toolName: 'search_notes',
      isError: false,
      effectiveText: '[screened MCP output]',
      withheld: false,
    });
    const tool = createMcpTool({ gateway: mcpGateway });
    const controller = new AbortController();

    const result = await tool.execute('call-1', {
      action: 'call',
      server_id: 'notes',
      tool_name: 'search_notes',
      arguments: { query: 'Example Person' },
    }, controller.signal);

    expect(mcpGateway.mcpExecute).toHaveBeenCalledWith({
      action: 'call',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'Example Person' },
    }, {
      toolCallId: 'call-1',
      signal: controller.signal,
    });
    expect(text(result)).toBe('[screened MCP output]');
  });

  it('releases one server or every companion session without retaining definitions', async () => {
    const mcpGateway = gateway({ action: 'release', serverId: 'notes', released: true });
    const tool = createMcpTool({ gateway: mcpGateway });

    await expect(tool.execute('release-1', { action: 'release', server_id: 'notes' }))
      .resolves.toMatchObject({ details: { mcp: { action: 'release', released: true } } });
    expect(mcpGateway.mcpExecute).toHaveBeenCalledWith(
      { action: 'release', serverId: 'notes' },
      { toolCallId: 'release-1' },
    );
  });

  it('returns structured approval and policy errors without throwing raw RPC failures into the turn', async () => {
    const mcpGateway = gateway();
    mcpGateway.mcpExecute.mockRejectedValue(new JSONRPCErrorException(
      'MCP call is pending operator approval',
      GatewayErrors.NEEDS_APPROVAL,
      { approvalId: 'approval-1' },
    ));
    const tool = createMcpTool({ gateway: mcpGateway });

    const result = await tool.execute('call-3', {
      action: 'call', server_id: 'notes', tool_name: 'write_note', arguments: { text: 'private' },
    });
    expect(text(result)).toContain('pending operator approval');
    expect(result.details).toMatchObject({
      isError: true,
      mcp: { action: 'call', approvalId: 'approval-1', code: GatewayErrors.NEEDS_APPROVAL },
    });
  });

  it('uses identity.read for discovery/release and external.mcp only for calls', () => {
    const tool = createMcpTool({ gateway: gateway() });
    for (const action of ['catalog', 'search', 'inspect', 'release']) {
      expect(resolveToolRequiredCapabilities(tool, { action })).toEqual(['identity.read']);
    }
    expect(resolveToolRequiredCapabilities(tool, { action: 'call' })).toEqual(['external.mcp']);
  });
});
