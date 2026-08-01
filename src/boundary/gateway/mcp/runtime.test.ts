import { describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault } from '../../custody/credential-vault.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { McpServersConfig } from '../../../system/config/mcp-servers-config.js';
import type { McpProtocolClientFactory } from './broker.js';
import { composeMcpGatewayRuntime } from './runtime.js';

function config(enabled: boolean): McpServersConfig {
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
      displayName: 'Notes',
      enabled,
      description: 'Private notes',
      endpoint: 'https://localhost:8443/mcp',
      allowedCompanionIds: ['ada'],
      authentication: { kind: 'bearer', tokenRef: { kind: 'env', envName: 'MCP_TOKEN' } },
      trust: {
        level: 'primary',
        factors: { hosting: 'loopback', dataOwnership: 'operator_private', inputExposure: 'closed' },
      },
      toolPolicy: { default: 'deny', tools: {} },
    }],
  };
}

const clientFactory: McpProtocolClientFactory = {
  create: vi.fn(async () => {
    throw new Error('must stay lazy');
  }),
};

describe('MCP gateway runtime composition', () => {
  it('does not require secrets or CogSec when every MCP server is disabled', () => {
    const runtime = composeMcpGatewayRuntime({
      config: config(false),
      screeningFor: () => null,
      clientFactory,
    });

    expect(runtime.broker).toBeNull();
    expect(runtime.enabledServerCount).toBe(0);
  });

  it('fails startup when enabled MCP ingress has no CogSec service or credential vault', () => {
    expect(() => composeMcpGatewayRuntime({
      config: config(true),
      screeningFor: () => null,
      clientFactory,
    })).toThrow(/credential vault/);

    expect(() => composeMcpGatewayRuntime({
      config: config(true),
      credentialVault: createStaticCredentialVault({ MCP_TOKEN: 'secret' }),
      screeningFor: () => null,
      clientFactory,
    })).toThrow(/CogSec screening.*ada/);
  });

  it('constructs a lazy broker when every allowed companion has CogSec', () => {
    const screening = { mode: 'enforce' } as IntakeScreeningService;
    const runtime = composeMcpGatewayRuntime({
      config: config(true),
      credentialVault: createStaticCredentialVault({ MCP_TOKEN: 'secret' }),
      screeningFor: companionId => companionId === 'ada' ? screening : null,
      clientFactory,
    });

    expect(runtime.enabledServerCount).toBe(1);
    expect(runtime.broker?.getCatalog({ companionId: 'ada' })).toHaveLength(1);
    expect(clientFactory.create).not.toHaveBeenCalled();
  });
});
