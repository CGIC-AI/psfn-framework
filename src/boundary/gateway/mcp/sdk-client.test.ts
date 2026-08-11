import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault } from '../../custody/credential-vault.js';
import type { McpServerConfig } from '../../../system/config/mcp-servers-config.js';

const sdk = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  transports: [] as Array<{ url: URL; options: Record<string, unknown> }>,
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = vi.fn(async () => {});
    listTools = vi.fn(async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }));
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    close = vi.fn(async () => {});

    constructor(_implementation: unknown, options: unknown) {
      sdk.clientOptions.push(options);
      sdk.clients.push(this);
    }
  },
  StreamableHTTPClientTransport: class {
    constructor(readonly url: URL, readonly options: Record<string, unknown>) {
      sdk.transports.push({ url, options });
    }
  },
}));

import { createMcpSdkClientFactory } from './sdk-client.js';

function server(): McpServerConfig {
  return {
    id: 'notes',
    displayName: 'Notes',
    enabled: true,
    description: 'Private notes',
    endpoint: 'https://localhost:8443/mcp',
    tls: { caCertificateRef: { kind: 'env', envName: 'MCP_CA_PEM' } },
    allowedCompanionIds: ['example-person'],
    authentication: {
      kind: 'bearer',
      tokenRef: { kind: 'env', envName: 'MCP_TOKEN' },
    },
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
        search: {
          effect: 'read',
          confirmation: 'never',
          maxOutboundSensitivity: 'confidential',
        },
      },
    },
  };
}

describe('official MCP SDK client adapter', () => {
  beforeEach(() => {
    sdk.clientOptions.length = 0;
    sdk.clients.length = 0;
    sdk.transports.length = 0;
  });

  it('uses Streamable HTTPS, 2026 negotiation, vault auth, bounded requests, and explicit close', async () => {
    const secureClose = vi.fn(async () => {});
    const secureFetch = vi.fn(async () => new Response('{}')) as typeof fetch;
    const secureFetchFactory = vi.fn(() => ({ fetch: secureFetch, close: secureClose }));
    const onToolsChanged = vi.fn();
    const factory = createMcpSdkClientFactory({
      credentialVault: createStaticCredentialVault({
        MCP_TOKEN: 'bearer-secret',
        MCP_CA_PEM: 'private-ca-pem',
      }),
      secureFetchFactory,
    });

    const port = await factory.create({
      companionId: 'example-person',
      server: server(),
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxPaginationPages: 12,
      maxDynamicOutputBytes: 1_048_576,
      onToolsChanged,
    });

    expect(secureFetchFactory).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{
        url: 'https://localhost:8443/mcp',
        allowInternalNetwork: true,
        tlsCa: 'private-ca-pem',
      }],
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
    }));
    expect(sdk.clientOptions[0]).toMatchObject({
      enforceStrictCapabilities: true,
      inputRequired: { autoFulfill: false },
      listMaxPages: 12,
      defaultCacheTtlMs: 0,
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000, maxRetries: 0 } },
    });
    expect(sdk.transports[0]?.url.toString()).toBe('https://localhost:8443/mcp');
    await expect((sdk.transports[0]?.options.authProvider as { token(): Promise<string> }).token())
      .resolves.toBe('bearer-secret');
    expect(sdk.clients[0]?.connect).toHaveBeenCalledWith(
      expect.anything(),
      { timeout: 5_000, maxTotalTimeout: 5_000 },
    );

    await port.listTools({ timeoutMs: 2_000 });
    await port.callTool({
      name: 'search',
      arguments: { query: 'Example Person' },
      toolDefinition: { name: 'search', inputSchema: { type: 'object' } },
      timeoutMs: 3_000,
    });
    expect(sdk.clients[0]?.listTools).toHaveBeenCalledWith(
      undefined,
      { timeout: 2_000, cacheMode: 'refresh' },
    );
    expect(sdk.clients[0]?.callTool).toHaveBeenCalledWith(
      { name: 'search', arguments: { query: 'Example Person' } },
      expect.objectContaining({ timeout: 3_000 }),
    );

    const listChanged = (sdk.clientOptions[0] as {
      listChanged: { tools: { onChanged(error: Error | null, tools: unknown[] | null): void } };
    }).listChanged.tools;
    listChanged.onChanged(null, null);
    expect(onToolsChanged).toHaveBeenCalledTimes(1);

    await port.close();
    expect(sdk.clients[0]?.close).toHaveBeenCalledTimes(1);
    expect(secureClose).toHaveBeenCalledTimes(1);
  });
});
