import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tool } from '@modelcontextprotocol/client';
import {
  generateCaMaterial,
  issueCertificate,
  loadCa,
  type CaMaterial,
  type IssuedCertificate,
} from '../../../app/cert-manager/pki.js';
import { createStaticCredentialVault } from '../../custody/credential-vault.js';
import type { McpServersConfig } from '../../../system/config/mcp-servers-config.js';
import {
  createMcpGatewayBroker,
  fingerprintMcpToolDefinition,
  type McpCogSecScreeningPort,
  type McpGatewayBroker,
} from './broker.js';
import { createMcpSdkClientFactory } from './sdk-client.js';

const BEARER_TOKEN = 'mcp-integration-secret';
const PROTOCOL_VERSION = '2026-07-28';

const INITIAL_SEARCH_TOOL: Tool = {
  name: 'search_notes',
  description: 'Search private notes',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};
const WRITE_TOOL: Tool = {
  name: 'write_note',
  description: 'Write a private note',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface WireObservation {
  method: string;
  authorization: string | undefined;
  protocolVersion: string | undefined;
  mcpMethod: string | undefined;
  tlsProtocol: string | null;
}

interface TestEndpoint {
  server: HttpsServer;
  url: string;
  observations: WireObservation[];
  authFailures: number;
  metadataRevision: number;
}

let caMaterial: CaMaterial;
let serverCertificate: IssuedCertificate;
let broker: McpGatewayBroker | undefined;
let endpoint: TestEndpoint | undefined;

beforeAll(async () => {
  caMaterial = await generateCaMaterial({
    commonName: 'PSFN MCP integration test CA',
    validityDays: 30,
  });
  const ca = await loadCa(caMaterial.certPem, caMaterial.keyPem);
  serverCertificate = await issueCertificate({
    kind: 'server',
    identityId: 'mcp-test-server',
    sans: ['127.0.0.1'],
    validityDays: 7,
    ca,
  });
});

afterEach(async () => {
  await broker?.close();
  broker = undefined;
  if (endpoint) {
    await new Promise<void>((resolve, reject) => {
      endpoint!.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  endpoint = undefined;
});

async function readJson(request: IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function result(
  request: JsonRpcRequest,
  value: unknown,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id: request.id, result: value };
}

async function startEndpoint(): Promise<TestEndpoint> {
  const state: TestEndpoint = {
    server: undefined as unknown as HttpsServer,
    url: '',
    observations: [],
    authFailures: 0,
    metadataRevision: 1,
  };
  const server = createHttpsServer(
    {
      cert: serverCertificate.certPem,
      key: serverCertificate.keyPem,
      minVersion: 'TLSv1.2',
    },
    (request, response) => {
      void (async () => {
        if (request.url !== '/mcp' || request.method !== 'POST') {
          response.writeHead(405);
          response.end();
          return;
        }
        if (request.headers.authorization !== `Bearer ${BEARER_TOKEN}`) {
          state.authFailures += 1;
          response.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer',
          });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        try {
          const message = await readJson(request);
          state.observations.push({
            method: message.method,
            authorization: request.headers.authorization,
            protocolVersion: request.headers['mcp-protocol-version'] as
              string | undefined,
            mcpMethod: request.headers['mcp-method'] as string | undefined,
            tlsProtocol: request.socket.getProtocol(),
          });
          if (message.method === 'server/discover') {
            sendJson(
              response,
              result(message, {
                resultType: 'complete',
                ttlMs: 0,
                cacheScope: 'private',
                supportedVersions: [PROTOCOL_VERSION],
                capabilities: { tools: {} },
                _meta: {
                  'io.modelcontextprotocol/serverInfo': {
                    name: 'psfn-test-mcp',
                    version: '1.0.0',
                  },
                },
              }),
            );
            return;
          }
          if (message.method === 'tools/list') {
            const suffix = state.metadataRevision === 1 ? '' : ' (updated)';
            sendJson(
              response,
              result(message, {
                resultType: 'complete',
                ttlMs: 0,
                cacheScope: 'private',
                tools: [
                  {
                    name: 'search_notes',
                    description: `Search private notes${suffix}`,
                    inputSchema: {
                      type: 'object',
                      properties: { query: { type: 'string' } },
                      required: ['query'],
                    },
                  },
                  {
                    name: 'write_note',
                    description: 'Write a private note',
                    inputSchema: {
                      type: 'object',
                      properties: { text: { type: 'string' } },
                      required: ['text'],
                    },
                  },
                ],
              }),
            );
            return;
          }
          if (message.method === 'tools/call') {
            sendJson(
              response,
              result(message, {
                resultType: 'complete',
                content: [
                  {
                    type: 'text',
                    text: `raw-private-result-${state.metadataRevision}`,
                  },
                ],
                isError: false,
              }),
            );
            return;
          }
          sendJson(response, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          });
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid request' }));
        }
      })();
    },
  );
  state.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  state.url = `https://127.0.0.1:${address.port}/mcp`;
  return state;
}

function config(url: string): McpServersConfig {
  return {
    schemaVersion: 1,
    limits: {
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      idleConnectionTtlMs: 30_000,
      metadataCacheTtlMs: 100,
      maxCatalogToolsPerServer: 16,
      maxPaginationPages: 4,
      maxStaticMetadataBytes: 64 * 1_024,
      maxDynamicOutputBytes: 64 * 1_024,
    },
    servers: [
      {
        id: 'notes',
        displayName: 'Private notes',
        enabled: true,
        description: 'Operator-owned journal integration.',
        endpoint: url,
        tls: { caCertificateRef: { kind: 'env', envName: 'MCP_TEST_CA' } },
        allowedCompanionIds: ['example-person'],
        authentication: {
          kind: 'bearer',
          tokenRef: { kind: 'env', envName: 'MCP_TEST_TOKEN' },
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
            search_notes: {
              effect: 'read',
              confirmation: 'never',
              maxOutboundSensitivity: 'confidential',
              metadataSha256: fingerprintMcpToolDefinition(INITIAL_SEARCH_TOOL),
            },
            write_note: {
              effect: 'write',
              confirmation: 'sensitive',
              maxOutboundSensitivity: 'confidential',
              metadataSha256: fingerprintMcpToolDefinition(WRITE_TOOL),
            },
          },
        },
      },
    ],
  };
}

function screening(): McpCogSecScreeningPort {
  return {
    screenStaticMetadata: vi.fn(async (input) => ({
      effectiveText: input.text,
      withheld: false,
    })),
    screenDynamicOutput: vi.fn(async () => ({
      effectiveText: '[CogSec-screened MCP output]',
      withheld: false,
    })),
  };
}

describe('MCP Streamable HTTPS certification', () => {
  it('negotiates the 2026 protocol over verified TLS and preserves lazy, screened lifecycle semantics', async () => {
    endpoint = await startEndpoint();
    let now = 1_000;
    const cogsec = screening();
    const clientFactory = createMcpSdkClientFactory({
      credentialVault: createStaticCredentialVault({
        MCP_TEST_CA: caMaterial.certPem,
        MCP_TEST_TOKEN: BEARER_TOKEN,
      }),
    });
    broker = createMcpGatewayBroker({
      config: config(endpoint.url),
      clientFactory,
      screening: cogsec,
      now: () => now,
    });

    expect(broker.getCatalog({ companionId: 'example-person' })).toHaveLength(1);
    expect(endpoint.observations).toEqual([]);

    await expect(
      broker.searchTools({ companionId: 'example-person', query: 'notes' }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'search_notes' }),
      ]),
    );
    expect(endpoint.observations.map((entry) => entry.method)).toEqual([
      'server/discover',
      'tools/list',
    ]);
    expect(endpoint.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorization: `Bearer ${BEARER_TOKEN}`,
          protocolVersion: PROTOCOL_VERSION,
          tlsProtocol: expect.stringMatching(/^TLSv1\.[23]$/u),
        }),
      ]),
    );
    expect(endpoint.observations[0]).toMatchObject({
      method: 'server/discover',
      mcpMethod: 'server/discover',
    });

    await broker.searchTools({ companionId: 'example-person', query: 'private' });
    expect(
      endpoint.observations.filter((entry) => entry.method === 'tools/list'),
    ).toHaveLength(1);
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(1);
    const firstHash = broker.health({ companionId: 'example-person' }).servers[0]?.metadata
      .sha256;

    now += 101;
    await broker.searchTools({ companionId: 'example-person', query: 'private' });
    expect(
      endpoint.observations.filter((entry) => entry.method === 'tools/list'),
    ).toHaveLength(2);
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(1);

    const first = await broker.invokeTool({
      companionId: 'example-person',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'private' },
      outboundSensitivity: 'confidential',
    });
    const second = await broker.invokeTool({
      companionId: 'example-person',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'journal' },
      outboundSensitivity: 'confidential',
    });
    expect(first.effectiveText).toBe('[CogSec-screened MCP output]');
    expect(second.effectiveText).toBe('[CogSec-screened MCP output]');
    expect(JSON.stringify([first, second])).not.toContain('raw-private-result');
    expect(cogsec.screenDynamicOutput).toHaveBeenCalledTimes(2);

    endpoint.metadataRevision = 2;
    now += 101;
    await broker.searchTools({ companionId: 'example-person', query: 'updated' });
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(2);
    expect(
      broker.health({ companionId: 'example-person' }).servers[0]?.metadata.sha256,
    ).not.toBe(firstHash);
    await expect(broker.invokeTool({
      companionId: 'example-person',
      serverId: 'notes',
      toolName: 'search_notes',
      arguments: { query: 'changed' },
      outboundSensitivity: 'public',
    })).rejects.toMatchObject({ code: 'TOOL_DENIED' });

    const callsBeforeDenials = endpoint.observations.filter(
      (entry) => entry.method === 'tools/call',
    ).length;
    await expect(
      broker.invokeTool({
        companionId: 'example-person',
        serverId: 'notes',
        toolName: 'unknown_tool',
        arguments: {},
        outboundSensitivity: 'public',
      }),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(
      broker.invokeTool({
        companionId: 'example-person',
        serverId: 'notes',
        toolName: 'write_note',
        arguments: { text: 'intimate' },
        outboundSensitivity: 'intimate',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(
      endpoint.observations.filter((entry) => entry.method === 'tools/call'),
    ).toHaveLength(callsBeforeDenials);

    await broker.invokeTool({
      companionId: 'example-person',
      serverId: 'notes',
      toolName: 'write_note',
      arguments: { text: 'operator approved' },
      outboundSensitivity: 'intimate',
      confirmed: true,
    });
    expect(cogsec.screenDynamicOutput).toHaveBeenCalledTimes(3);

    const discoveryCount = endpoint.observations.filter(
      (entry) => entry.method === 'server/discover',
    ).length;
    await broker.releaseServer({ companionId: 'example-person', serverId: 'notes' });
    expect(broker.health({ companionId: 'example-person' })).toMatchObject({
      activeSessions: 0,
    });
    await broker.searchTools({ companionId: 'example-person', query: 'updated' });
    expect(
      endpoint.observations.filter(
        (entry) => entry.method === 'server/discover',
      ),
    ).toHaveLength(discoveryCount + 1);
    expect(cogsec.screenStaticMetadata).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the configured bearer credential is rejected', async () => {
    endpoint = await startEndpoint();
    broker = createMcpGatewayBroker({
      config: config(endpoint.url),
      clientFactory: createMcpSdkClientFactory({
        credentialVault: createStaticCredentialVault({
          MCP_TEST_CA: caMaterial.certPem,
          MCP_TEST_TOKEN: 'wrong-secret',
        }),
      }),
      screening: screening(),
    });

    let failure: unknown;
    try {
      await broker.searchTools({ companionId: 'example-person', query: 'notes' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('wrong-secret');
    expect(String(failure)).not.toContain(BEARER_TOKEN);
    expect(endpoint.authFailures).toBe(1);
    expect(endpoint.observations).toEqual([]);
  });
});
