import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MCP_SERVERS_FILE_NAME,
  MCP_SERVERS_SEED_FILE_NAME,
  loadMcpServersConfig,
  loadMcpServersSeedDefaults,
  validateMcpServersConfig,
} from './mcp-servers-config.js';

function validConfig(): Record<string, unknown> {
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
      id: 'private-notes',
      displayName: 'Private Notes',
      enabled: true,
      description: 'Operator-owned personal knowledge base.',
      endpoint: 'https://localhost:8443/mcp',
      allowedCompanionIds: ['companion-a'],
      authentication: {
        kind: 'bearer',
        tokenRef: { kind: 'env', envName: 'MCP_PRIVATE_NOTES_TOKEN' },
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
          search_notes: { effect: 'read', confirmation: 'never' },
          write_note: { effect: 'write', confirmation: 'sensitive' },
        },
      },
    }],
  };
}

describe('MCP servers owner config', () => {
  it('accepts an authenticated HTTPS server with an operator-owned trust profile', () => {
    expect(validateMcpServersConfig(validConfig(), 'mcp-servers.json')).toEqual(validConfig());
  });

  it('accepts a gateway-vault reference for a private TLS certificate authority', () => {
    const config = validConfig();
    const server = (config.servers as Array<Record<string, unknown>>)[0];
    server.tls = {
      caCertificateRef: { kind: 'env', envName: 'MCP_PRIVATE_CA_PEM' },
    };

    expect(validateMcpServersConfig(config, 'mcp-servers.json').servers[0].tls)
      .toEqual({ caCertificateRef: { kind: 'env', envName: 'MCP_PRIVATE_CA_PEM' } });
  });

  it.each([
    ['remote_shared', 'operator_private', 'closed', 'trusted'],
    ['loopback', 'operator_work', 'closed', 'primary'],
    ['loopback', 'operator_private', 'multi_party', 'trusted'],
  ])(
    'rejects %s/%s/%s factors claiming the higher %s trust level',
    (hosting, dataOwnership, inputExposure, level) => {
      const config = validConfig();
      const server = (config.servers as Array<Record<string, unknown>>)[0];
      server.endpoint = hosting === 'loopback'
        ? 'https://localhost:8443/mcp'
        : 'https://mcp.example.com/mcp';
      server.trust = {
        level,
        factors: { hosting, dataOwnership, inputExposure },
      };

      expect(() => validateMcpServersConfig(config, 'mcp-servers.json'))
        .toThrow(/cannot exceed the ceiling derived from hosting\/data\/input factors/);
    },
  );

  it('loads the disabled seed while still requiring an explicit runtime owner file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-owner-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    const seed = { ...validConfig(), servers: [] };
    writeFileSync(
      join(seedDir, MCP_SERVERS_SEED_FILE_NAME),
      `${JSON.stringify(seed)}\n`,
      'utf8',
    );

    try {
      expect(loadMcpServersSeedDefaults({ seedDir })).toEqual(seed);
      expect(() => loadMcpServersConfig(dataDir, { seedDir }))
        .toThrow(/Missing required JSON owner file/);
      writeFileSync(
        join(dataDir, MCP_SERVERS_FILE_NAME),
        `${JSON.stringify(seed)}\n`,
        'utf8',
      );
      expect(loadMcpServersConfig(dataDir, { seedDir })).toEqual(seed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['http://localhost:8443/mcp', /must use HTTPS\/TLS/],
    ['stdio://local-command', /absolute HTTPS URL|HTTPS\/TLS/],
    ['https://user:secret@mcp.example.com/mcp', /must not embed credentials/],
  ])('rejects unsupported or credential-bearing endpoint %s', (endpoint, expected) => {
    const config = validConfig();
    const server = (config.servers as Array<Record<string, unknown>>)[0];
    server.endpoint = endpoint;
    if (endpoint.includes('example.com')) {
      server.trust = {
        level: 'regular',
        factors: {
          hosting: 'remote_shared',
          dataOwnership: 'mixed',
          inputExposure: 'multi_party',
        },
      };
    }
    expect(() => validateMcpServersConfig(config, 'mcp-servers.json')).toThrow(expected);
  });

  it('allows an operator to narrow but never widen sensitivity disclosure', () => {
    const narrowed = validConfig();
    const narrowedServer = (narrowed.servers as Array<Record<string, unknown>>)[0];
    narrowedServer.trust = {
      level: 'primary',
      factors: {
        hosting: 'loopback',
        dataOwnership: 'operator_private',
        inputExposure: 'closed',
      },
      allowedOutboundSensitivity: ['public', 'personal'],
    };
    expect(validateMcpServersConfig(narrowed, 'mcp-servers.json').servers[0].trust)
      .toMatchObject({ allowedOutboundSensitivity: ['public', 'personal'] });

    const widened = validConfig();
    const widenedServer = (widened.servers as Array<Record<string, unknown>>)[0];
    widenedServer.endpoint = 'https://mcp.example.com/mcp';
    widenedServer.trust = {
      level: 'regular',
      factors: {
        hosting: 'remote_shared',
        dataOwnership: 'mixed',
        inputExposure: 'multi_party',
      },
      allowedOutboundSensitivity: ['intimate'],
    };
    expect(() => validateMcpServersConfig(widened, 'mcp-servers.json'))
      .toThrow(/cannot widen the regular trust ceiling/);
  });

  it('requires destructive and control tools to remain explicitly confirmed', () => {
    const config = validConfig();
    const server = (config.servers as Array<Record<string, unknown>>)[0];
    server.toolPolicy = {
      default: 'deny',
      tools: {
        delete_note: { effect: 'destructive', confirmation: 'never' },
      },
    };

    expect(() => validateMcpServersConfig(config, 'mcp-servers.json'))
      .toThrow(/destructive.*confirmation.*always/);
  });

  it('binds OAuth client credentials to a token endpoint on the expected issuer origin', () => {
    const config = validConfig();
    const server = (config.servers as Array<Record<string, unknown>>)[0];
    server.authentication = {
      kind: 'oauth_client_credentials',
      clientId: 'psfn',
      clientSecretRef: { kind: 'env', envName: 'MCP_OAUTH_SECRET' },
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      expectedIssuer: 'https://issuer.example.com/',
      scopes: ['mcp.read'],
    };

    expect(() => validateMcpServersConfig(config, 'mcp-servers.json'))
      .toThrow(/tokenEndpoint.*same origin.*expectedIssuer/);
  });

  it('rejects API-key headers that could subvert HTTP routing or MCP protocol framing', () => {
    for (const headerName of ['Host', 'Cookie', 'Mcp-Session-Id', 'Content-Length']) {
      const config = validConfig();
      const server = (config.servers as Array<Record<string, unknown>>)[0];
      server.authentication = {
        kind: 'api_key',
        headerName,
        valueRef: { kind: 'env', envName: 'MCP_API_KEY' },
      };

      expect(() => validateMcpServersConfig(config, 'mcp-servers.json'))
        .toThrow(/reserved for transport custody/);
    }
  });
});
