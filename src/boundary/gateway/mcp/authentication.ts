import type { AuthProvider, StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';
import type { McpAuthenticationConfig } from '../../../system/config/mcp-servers-config.js';
import { isRecord } from '../../../shared/utils/types.js';

export interface McpTransportAuthentication {
  authProvider?: AuthProvider;
  requestInit?: RequestInit;
}

function requiredCredential(
  vault: CredentialVaultPort,
  config: McpAuthenticationConfig,
): string {
  if (config.kind === 'bearer') {
    return vault.resolveRequired(config.tokenRef, 'MCP bearer token');
  }
  if (config.kind === 'api_key') {
    return vault.resolveRequired(config.valueRef, 'MCP API key');
  }
  return vault.resolveRequired(config.clientSecretRef, 'MCP OAuth client secret');
}

function formEncodeBasicPart(value: string): string {
  return encodeURIComponent(value).replace(/%20/gu, '+');
}

function oauthBasicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(
    `${formEncodeBasicPart(clientId)}:${formEncodeBasicPart(clientSecret)}`,
    'utf8',
  ).toString('base64')}`;
}

function parseTokenResponse(value: unknown): {
  accessToken: string;
  expiresInSeconds: number;
} {
  if (!isRecord(value)
    || typeof value.access_token !== 'string'
    || value.access_token.length === 0
    || value.access_token.length > 65_536
    || typeof value.token_type !== 'string'
    || value.token_type.toLowerCase() !== 'bearer'
    || !Number.isSafeInteger(value.expires_in)
    || (value.expires_in as number) < 1
    || (value.expires_in as number) > 86_400) {
    throw new Error('MCP OAuth token endpoint returned an invalid bearer token response');
  }
  return {
    accessToken: value.access_token,
    expiresInSeconds: value.expires_in as number,
  };
}

function createOAuthClientCredentialsProvider(input: {
  config: Extract<McpAuthenticationConfig, { kind: 'oauth_client_credentials' }>;
  credentialVault: CredentialVaultPort;
  fetch: typeof fetch;
  now: () => number;
}): AuthProvider {
  let currentToken: string | undefined;
  let refreshAt = 0;
  let inFlight: Promise<string> | undefined;

  async function requestToken(): Promise<string> {
    const secret = requiredCredential(input.credentialVault, input.config);
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (input.config.scopes.length > 0) body.set('scope', input.config.scopes.join(' '));
    const response = await input.fetch(input.config.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: oauthBasicAuthorization(input.config.clientId, secret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`MCP OAuth token endpoint rejected client credentials with HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error('MCP OAuth token endpoint returned a non-JSON response');
    }
    const parsed = parseTokenResponse(await response.json());
    currentToken = parsed.accessToken;
    const lifetimeMs = parsed.expiresInSeconds * 1_000;
    const refreshSkewMs = Math.min(30_000, Math.max(1_000, Math.floor(lifetimeMs / 10)));
    refreshAt = input.now() + Math.max(0, lifetimeMs - refreshSkewMs);
    return parsed.accessToken;
  }

  return {
    async token() {
      if (currentToken && input.now() < refreshAt) return currentToken;
      inFlight ??= requestToken().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async onUnauthorized() {
      currentToken = undefined;
      refreshAt = 0;
    },
  } satisfies AuthProvider;
}

export function createMcpTransportAuthentication(input: {
  config: McpAuthenticationConfig;
  credentialVault: CredentialVaultPort;
  fetch: typeof fetch;
  now?: () => number;
}): McpTransportAuthentication {
  if (input.config.kind === 'bearer') {
    return {
      authProvider: {
        token: async () => requiredCredential(input.credentialVault, input.config),
      },
    };
  }
  if (input.config.kind === 'api_key') {
    return {
      requestInit: {
        headers: {
          [input.config.headerName]: requiredCredential(input.credentialVault, input.config),
        },
      },
    };
  }
  return {
    authProvider: createOAuthClientCredentialsProvider({
      config: input.config,
      credentialVault: input.credentialVault,
      fetch: input.fetch,
      now: input.now ?? Date.now,
    }),
  } satisfies Pick<StreamableHTTPClientTransportOptions, 'authProvider' | 'requestInit'>;
}
