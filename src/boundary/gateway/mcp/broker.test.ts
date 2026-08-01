import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServersConfig } from '../../../system/config/mcp-servers-config.js';
import {
  McpBrokerError,
  createMcpGatewayBroker,
  type McpCogSecScreeningPort,
  type McpProtocolClientFactory,
  type McpProtocolClientPort,
} from './broker.js';

function config(): McpServersConfig {
  return {
    schemaVersion: 1,
    limits: {
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      idleConnectionTtlMs: 300_000,
      metadataCacheTtlMs: 300_000,
      maxCatalogToolsPerServer: 256,
      maxPaginationPages: 32,
      maxStaticMetadataBytes: 1_048_576,
      maxDynamicOutputBytes: 4_194_304,
    },
    servers: [{
      id: 'notes',
      displayName: 'Private notes',
      enabled: true,
      description: 'Search and update the operator-owned knowledge base.',
      endpoint: 'https://localhost:8443/mcp',
      allowedCompanionIds: ['ada'],
      authentication: { kind: 'bearer', tokenRef: { kind: 'env', envName: 'MCP_NOTES_TOKEN' } },
      trust: {
        level: 'primary',
        factors: {
          hosting: 'loopback',
          dataOwnership: 'operator_private',
          inputExposure: 'closed',
        },
      },
      toolPolicy: {
        default: 'deny',
        tools: {
          search_notes: { effect: 'read', confirmation: 'never' },
          write_note: { effect: 'write', confirmation: 'sensitive' },
        },
      },
    }],
  };
}

function fakeProtocolClient() {
  let onToolsChanged: (() => void) | undefined;
  const client: McpProtocolClientPort = {
    listTools: vi.fn(async () => ({
      tools: [{
        name: 'search_notes',
        description: 'Search private notes',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }, {
        name: 'write_note',
        description: 'Write a note',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      }],
    })),
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: 'a private result' }],
      isError: false,
    })),
    close: vi.fn(async () => {}),
  };
  const factory: McpProtocolClientFactory = {
    create: vi.fn(async (input) => {
      onToolsChanged = input.onToolsChanged;
      return client;
    }),
  };
  return { client, factory, notifyToolsChanged: () => onToolsChanged?.() };
}

function screening(): McpCogSecScreeningPort {
  return {
    screenStaticMetadata: vi.fn(async (input) => ({
      effectiveText: input.text,
      withheld: false,
    })),
    screenDynamicOutput: vi.fn(async (input) => ({
      effectiveText: input.text,
      withheld: false,
    })),
  };
}

describe('MCP gateway broker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the operator-owned server catalog without connecting', () => {
    const fake = fakeProtocolClient();
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: screening(),
    });

    expect(broker.getCatalog({ companionId: 'ada' })).toEqual([{
      serverId: 'notes',
      displayName: 'Private notes',
      description: 'Search and update the operator-owned knowledge base.',
      trustLevel: 'primary',
    }]);
    expect(fake.factory.create).not.toHaveBeenCalled();
  });

  it('loads tool summaries lazily, reuses a companion/server session, and rescans only changed metadata', async () => {
    const fake = fakeProtocolClient();
    const cogsec = screening();
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: cogsec,
    });

    await expect(broker.searchTools({ companionId: 'ada', query: 'notes' }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ serverId: 'notes', toolName: 'search_notes' }),
      ]));
    await broker.searchTools({ companionId: 'ada', query: 'private' });

    expect(fake.factory.create).toHaveBeenCalledTimes(1);
    expect(fake.client.listTools).toHaveBeenCalledTimes(1);
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(1);

    fake.notifyToolsChanged();
    await broker.searchTools({ companionId: 'ada', query: 'notes' });

    expect(fake.client.listTools).toHaveBeenCalledTimes(2);
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(1);
  });

  it('projects companion-scoped content-free health with policy and screened hash state', async () => {
    const fake = fakeProtocolClient();
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: screening(),
    });

    expect(broker.health({ companionId: 'ada' })).toMatchObject({
      activeSessions: 0,
      servers: [{
        serverId: 'notes',
        displayName: 'Private notes',
        trustLevel: 'primary',
        activeSession: false,
        hasLoadedTools: false,
        metadata: { disposition: 'not_scanned' },
        tools: [
          { toolName: 'search_notes', effect: 'read', confirmation: 'never' },
          { toolName: 'write_note', effect: 'write', confirmation: 'sensitive' },
        ],
      }],
    });

    await broker.searchTools({ companionId: 'ada', query: 'notes' });
    const health = broker.health({ companionId: 'ada' });
    expect(health).toMatchObject({
      activeSessions: 1,
      cachedStaticMetadataEntries: 1,
      servers: [{
        serverId: 'notes',
        activeSession: true,
        hasLoadedTools: true,
        metadata: { disposition: 'passed', toolCount: 2 },
      }],
    });
    expect(health.servers[0]?.metadata.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(health)).not.toMatch(/endpoint|tokenRef|description|inputSchema|private result/iu);
    expect(broker.health({ companionId: 'eve' })).toMatchObject({
      activeSessions: 0,
      cachedStaticMetadataEntries: 0,
      servers: [],
    });
  });

  it('returns a selected schema only on inspect and unloads its session and definitions explicitly', async () => {
    const fake = fakeProtocolClient();
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: screening(),
    });

    await expect(broker.inspectTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'write_note',
    })).resolves.toMatchObject({
      serverId: 'notes',
      tool: {
        name: 'write_note',
        inputSchema: { type: 'object' },
      },
    });

    await broker.releaseServer({ companionId: 'ada', serverId: 'notes' });
    expect(fake.client.close).toHaveBeenCalledTimes(1);
    expect(broker.health().activeSessions).toBe(0);
  });

  it('unloads idle sessions and their loaded schemas at the configured TTL', async () => {
    vi.useFakeTimers();
    const fake = fakeProtocolClient();
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: screening(),
    });

    await broker.searchTools({ companionId: 'ada', query: 'notes' });
    expect(broker.health()).toMatchObject({
      activeSessions: 1,
      sessions: [{ companionId: 'ada', serverId: 'notes', hasLoadedTools: true }],
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
    expect(broker.health()).toMatchObject({ activeSessions: 0, sessions: [] });
  });

  it('screens every dynamic output and never returns the raw protocol payload', async () => {
    const fake = fakeProtocolClient();
    const cogsec = screening();
    vi.mocked(cogsec.screenDynamicOutput).mockResolvedValue({
      effectiveText: '[screened result]',
      withheld: false,
    });
    const broker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fake.factory,
      screening: cogsec,
    });

    const first = await broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'Ada' },
      outboundSensitivity: 'public',
    });
    const second = await broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'PSFN' },
      outboundSensitivity: 'public',
    });

    expect(first).toEqual({
      serverId: 'notes',
      toolName: 'search_notes',
      isError: false,
      effectiveText: '[screened result]',
      withheld: false,
    });
    expect(second.effectiveText).toBe('[screened result]');
    expect(cogsec.screenDynamicOutput).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain('a private result');
  });

  it('rejects oversized invocation arguments before external dispatch', async () => {
    const fake = fakeProtocolClient();
    const bounded = config();
    bounded.limits.maxDynamicOutputBytes = 64;
    const broker = createMcpGatewayBroker({
      config: bounded,
      clientFactory: fake.factory,
      screening: screening(),
    });

    await expect(broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'x'.repeat(256) },
      outboundSensitivity: 'personal',
    })).rejects.toMatchObject({ code: 'INVOCATION_ARGUMENTS_TOO_LARGE' });
    expect(fake.client.callTool).not.toHaveBeenCalled();
  });

  it('fails closed for unauthorized companions, unknown tools, excessive sensitivity, and missing confirmation', async () => {
    const fake = fakeProtocolClient();
    const restricted = config();
    restricted.servers[0]!.trust = {
      level: 'regular',
      factors: {
        hosting: 'loopback',
        dataOwnership: 'mixed',
        inputExposure: 'multi_party',
      },
    };
    const broker = createMcpGatewayBroker({
      config: restricted,
      clientFactory: fake.factory,
      screening: screening(),
    });

    expect(broker.getCatalog({ companionId: 'eve' })).toEqual([]);
    await expect(broker.inspectTool({
      companionId: 'eve',
      serverId: 'notes',
      toolName: 'search_notes',
    })).rejects.toMatchObject({ code: 'COMPANION_NOT_ALLOWED' } satisfies Partial<McpBrokerError>);
    await expect(broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'missing',
      arguments: {},
      outboundSensitivity: 'public',
    })).rejects.toMatchObject({ code: 'TOOL_DENIED' } satisfies Partial<McpBrokerError>);
    await expect(broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: {},
      outboundSensitivity: 'confidential',
    })).rejects.toMatchObject({ code: 'SENSITIVITY_DENIED' } satisfies Partial<McpBrokerError>);
    await expect(broker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'write_note',
      arguments: { text: 'intimate' },
      outboundSensitivity: 'intimate',
    })).rejects.toMatchObject({ code: 'SENSITIVITY_DENIED' } satisfies Partial<McpBrokerError>);

    const primaryBroker = createMcpGatewayBroker({
      config: config(),
      clientFactory: fakeProtocolClient().factory,
      screening: screening(),
    });
    await expect(primaryBroker.invokeTool({
      companionId: 'ada',
      serverId: 'notes',
      toolName: 'write_note',
      arguments: { text: 'intimate' },
      outboundSensitivity: 'intimate',
    })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' } satisfies Partial<McpBrokerError>);
  });
});
