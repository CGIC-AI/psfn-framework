import { describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault } from '../../custody/credential-vault.js';
import type { McpAuthenticationConfig } from '../../../system/config/mcp-servers-config.js';
import { createMcpTransportAuthentication } from './authentication.js';

describe('MCP transport authentication', () => {
  it('resolves bearer credentials from the gateway vault on every request', async () => {
    const vault = createStaticCredentialVault({ MCP_TOKEN: 'secret-bearer' });
    const config: McpAuthenticationConfig = {
      kind: 'bearer',
      tokenRef: { kind: 'env', envName: 'MCP_TOKEN' },
    };

    const auth = createMcpTransportAuthentication({
      config,
      credentialVault: vault,
      fetch: vi.fn(),
    });

    await expect(auth.authProvider?.token()).resolves.toBe('secret-bearer');
    expect(auth.requestInit).toBeUndefined();
  });

  it('injects configured API-key headers without putting secrets in the owner file', () => {
    const vault = createStaticCredentialVault({ MCP_API_KEY: 'secret-api-key' });
    const config: McpAuthenticationConfig = {
      kind: 'api_key',
      headerName: 'X-PSFN-Key',
      valueRef: { kind: 'env', envName: 'MCP_API_KEY' },
    };

    const auth = createMcpTransportAuthentication({
      config,
      credentialVault: vault,
      fetch: vi.fn(),
    });

    expect(new Headers(auth.requestInit?.headers).get('X-PSFN-Key')).toBe('secret-api-key');
    expect(auth.authProvider).toBeUndefined();
  });

  it('uses client credentials over the pinned token endpoint and caches only until expiry', async () => {
    let now = 1_000_000;
    const tokenFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Basic ${Buffer.from('psfn:secret-oauth').toString('base64')}`);
      expect(String(init?.body)).toContain('grant_type=client_credentials');
      expect(String(init?.body)).toContain('scope=mcp.read+mcp.write');
      return new Response(JSON.stringify({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 60,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const config: McpAuthenticationConfig = {
      kind: 'oauth_client_credentials',
      clientId: 'psfn',
      clientSecretRef: { kind: 'env', envName: 'MCP_OAUTH_SECRET' },
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      expectedIssuer: 'https://auth.example.com/',
      scopes: ['mcp.read', 'mcp.write'],
    };
    const auth = createMcpTransportAuthentication({
      config,
      credentialVault: createStaticCredentialVault({ MCP_OAUTH_SECRET: 'secret-oauth' }),
      fetch: tokenFetch,
      now: () => now,
    });

    await expect(auth.authProvider?.token()).resolves.toBe('access-token');
    await expect(auth.authProvider?.token()).resolves.toBe('access-token');
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    now += 61_000;
    await expect(auth.authProvider?.token()).resolves.toBe('access-token');
    expect(tokenFetch).toHaveBeenCalledTimes(2);
  });

  it('invalidates an OAuth token after a 401 without leaking the response body', async () => {
    let tokenNumber = 0;
    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: `access-${++tokenNumber}`,
      token_type: 'Bearer',
      expires_in: 60,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const auth = createMcpTransportAuthentication({
      config: {
        kind: 'oauth_client_credentials',
        clientId: 'psfn',
        clientSecretRef: { kind: 'env', envName: 'MCP_OAUTH_SECRET' },
        tokenEndpoint: 'https://auth.example.com/oauth/token',
        expectedIssuer: 'https://auth.example.com/',
        scopes: [],
      },
      credentialVault: createStaticCredentialVault({ MCP_OAUTH_SECRET: 'secret' }),
      fetch: tokenFetch,
    });

    await expect(auth.authProvider?.token()).resolves.toBe('access-1');
    await auth.authProvider?.onUnauthorized?.({
      response: new Response('attacker controlled', { status: 401 }),
      serverUrl: new URL('https://localhost:8443/mcp'),
      fetchFn: tokenFetch,
    });
    await expect(auth.authProvider?.token()).resolves.toBe('access-2');
  });
});
