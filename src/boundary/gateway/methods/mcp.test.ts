import { JSONRPCErrorException } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';
import type { McpGatewayBroker } from '../mcp/broker.js';
import { GatewayErrors } from '../protocol.js';
import {
  GatewayMcpRequestCancellation,
  registerMcpMethods,
} from './mcp.js';
import type { GatewayMethodRuntime } from './types.js';

const COMPANION_ID = '4b90c2e6-0663-4f01-9965-9d228fa848bd';

function broker(): McpGatewayBroker {
  return {
    getCatalog: vi.fn(() => [{
      serverId: 'notes',
      displayName: 'Private notes',
      description: 'Operator-owned notes.',
      trustLevel: 'primary',
    }]),
    searchTools: vi.fn(async () => [{
      serverId: 'notes',
      serverDisplayName: 'Private notes',
      toolName: 'search_notes',
      description: 'Search notes.',
      effect: 'read',
      confirmation: 'never',
    }]),
    inspectTool: vi.fn(async () => ({
      serverId: 'notes',
      serverDisplayName: 'Private notes',
      tool: {
        name: 'search_notes',
        description: 'Search notes.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      policy: { effect: 'read', confirmation: 'never' },
    })),
    invokeTool: vi.fn(async () => ({
      serverId: 'notes',
      toolName: 'search_notes',
      isError: false,
      effectiveText: '{"content":[{"type":"text","text":"screened"}]}',
      withheld: false,
    })),
    releaseServer: vi.fn(async () => {}),
    releaseCompanion: vi.fn(async () => {}),
    health: vi.fn(() => ({ activeSessions: 0, cachedStaticMetadataEntries: 0, sessions: [] })),
    close: vi.fn(async () => {}),
  };
}

function runtime(input: {
  broker?: McpGatewayBroker;
  companionId?: string;
  grantedTokens?: string[];
  requestExplicitApproval?: ReturnType<typeof vi.fn>;
}) {
  const methods = new Map<string, (params: unknown) => Promise<unknown>>();
  const value = {
    target: {
      addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
        methods.set(name, handler);
      },
    },
    mcpBroker: input.broker,
    mcpRequestCancellation: new GatewayMcpRequestCancellation(),
    authenticatedCompanionId: () => input.companionId ?? COMPANION_ID,
    capabilityGrantSnapshotProvider: () => ({
      tier: 'custom' as const,
      customTokens: input.grantedTokens ?? ['identity.read', 'external.mcp'],
      grantedTokens: input.grantedTokens ?? ['identity.read', 'external.mcp'],
    }),
    approvalBoundary: {
      requestExplicitApproval: input.requestExplicitApproval ?? vi.fn(),
    },
    audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
  } as unknown as GatewayMethodRuntime;
  registerMcpMethods(value);
  return { methods, runtime: value };
}

describe('MCP gateway RPC', () => {
  it('uses authenticated companion identity for catalog/search/inspect/call/release', async () => {
    const mcpBroker = broker();
    const { methods } = runtime({ broker: mcpBroker });
    const execute = methods.get('mcp.execute');

    await expect(execute?.({ action: 'catalog' })).resolves.toMatchObject({ action: 'catalog' });
    await expect(execute?.({ action: 'search', query: 'notes', limit: 3 })).resolves.toMatchObject({ action: 'search' });
    await expect(execute?.({
      action: 'inspect', serverId: 'notes', toolName: 'search_notes',
    })).resolves.toMatchObject({ action: 'inspect' });
    await expect(execute?.({
      action: 'call',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'Ada' },
      effectiveSensitivity: 'personal',
      cancellationId: 'de305d54-75b4-431b-adb2-eb6b9e546014',
    })).resolves.toMatchObject({ action: 'call', effectiveText: expect.stringContaining('screened') });
    await expect(execute?.({ action: 'release', serverId: 'notes' })).resolves.toEqual({
      action: 'release', serverId: 'notes', released: true,
    });

    expect(mcpBroker.getCatalog).toHaveBeenCalledWith({ companionId: COMPANION_ID });
    expect(mcpBroker.searchTools).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      query: 'notes',
    }));
    expect(mcpBroker.invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      outboundSensitivity: 'personal',
      confirmed: false,
    }));
    expect(mcpBroker.releaseServer).toHaveBeenCalledWith({
      companionId: COMPANION_ID,
      serverId: 'notes',
    });
  });

  it('rejects missing server capability at the gateway before broker dispatch', async () => {
    const mcpBroker = broker();
    const { methods } = runtime({ broker: mcpBroker, grantedTokens: ['identity.read'] });

    await expect(methods.get('mcp.execute')?.({
      action: 'call',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: {},
      effectiveSensitivity: 'public',
    })).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    expect(mcpBroker.invokeTool).not.toHaveBeenCalled();
  });

  it('rejects model/caller authority fields and malformed action shapes', async () => {
    const mcpBroker = broker();
    const { methods } = runtime({ broker: mcpBroker });
    const execute = methods.get('mcp.execute');

    await expect(execute?.({ action: 'catalog', companionId: 'spoofed' })).rejects.toThrow();
    await expect(execute?.({ action: 'call', serverId: 'notes', toolName: 'search_notes' }))
      .rejects.toThrow();
    await expect(execute?.({ action: 'unknown' })).rejects.toThrow();
    expect(mcpBroker.invokeTool).not.toHaveBeenCalled();
  });

  it('queues an exact-payload approval and only its queue executor may confirm the call', async () => {
    const mcpBroker = broker();
    vi.mocked(mcpBroker.invokeTool).mockRejectedValueOnce(Object.assign(
      new Error('confirmation required'),
      { name: 'McpBrokerError', code: 'CONFIRMATION_REQUIRED' },
    ));
    const requestExplicitApproval = vi.fn(async (input) => {
      expect(input.authenticatedCompanionId).toBe(COMPANION_ID);
      expect(input.request).toMatchObject({
        method: 'mcp.execute', action: 'call', scope: 'notes/search_notes',
      });
      return { id: 'approval-1', expiresAt: Date.now() + 60_000 };
    });
    const { methods } = runtime({ broker: mcpBroker, requestExplicitApproval });

    await expect(methods.get('mcp.execute')?.({
      action: 'call',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'Ada' },
      effectiveSensitivity: 'intimate',
    })).rejects.toMatchObject({
      code: GatewayErrors.NEEDS_APPROVAL,
      data: { approvalId: 'approval-1' },
    });
    expect(requestExplicitApproval).toHaveBeenCalledTimes(1);
  });

  it('cancels only the matching connection-scoped MCP request', async () => {
    const cancellation = new GatewayMcpRequestCancellation();
    let observedSignal: AbortSignal | undefined;
    const pending = cancellation.run(
      'de305d54-75b4-431b-adb2-eb6b9e546014',
      async signal => {
        observedSignal = signal;
        await new Promise<void>(() => {});
      },
    );

    expect(cancellation.cancel('de305d54-75b4-431b-adb2-eb6b9e546014')).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/iu);
    expect(observedSignal?.aborted).toBe(true);
    expect(cancellation.cancel('de305d54-75b4-431b-adb2-eb6b9e546014')).toBe(false);
  });

  it('uses structured policy errors instead of leaking broker internals', async () => {
    const mcpBroker = broker();
    vi.mocked(mcpBroker.inspectTool).mockRejectedValue(new Error('secret backend detail'));
    const { methods } = runtime({ broker: mcpBroker });

    await expect(methods.get('mcp.execute')?.({
      action: 'inspect', serverId: 'notes', toolName: 'search_notes',
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof JSONRPCErrorException
      && error.code === GatewayErrors.PROVIDER_ERROR
      && !error.message.includes('secret backend detail')
    ));
  });
});
