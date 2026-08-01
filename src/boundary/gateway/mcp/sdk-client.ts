import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';
import type { DnsResolver } from '../url-policy.js';
import type { McpProtocolClientFactory, McpProtocolClientPort } from './protocol-client.js';
import { createMcpTransportAuthentication } from './authentication.js';
import {
  createMcpSecureFetchController,
  type McpSecureFetchController,
  type McpSecureFetchTarget,
} from './secure-fetch.js';

export interface McpSecureFetchFactoryOptions {
  targets: McpSecureFetchTarget[];
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  dnsResolver?: DnsResolver;
}

export type McpSecureFetchFactory = (
  options: McpSecureFetchFactoryOptions,
) => McpSecureFetchController;

function internalNetworkAllowed(hosting: string): boolean {
  return hosting === 'loopback' || hosting === 'private_network';
}

async function closeBoth(
  client: Client,
  secureFetch: McpSecureFetchController,
): Promise<void> {
  const results = await Promise.allSettled([
    client.close(),
    secureFetch.close(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close MCP client resources');
  }
}

export function createMcpSdkClientFactory(options: {
  credentialVault: CredentialVaultPort;
  secureFetchFactory?: McpSecureFetchFactory;
  dnsResolver?: DnsResolver;
}): McpProtocolClientFactory {
  const secureFetchFactory = options.secureFetchFactory ?? createMcpSecureFetchController;

  return {
    async create(input): Promise<McpProtocolClientPort> {
      const allowInternalNetwork = internalNetworkAllowed(input.server.trust.factors.hosting);
      const tlsCa = input.server.tls
        ? options.credentialVault.resolveRequired(
          input.server.tls.caCertificateRef,
          `MCP TLS certificate authority for ${input.server.id}`,
        )
        : undefined;
      const endpointOrigin = new URL(input.server.endpoint).origin;
      const targets: McpSecureFetchTarget[] = [{
        url: input.server.endpoint,
        allowInternalNetwork,
        ...(tlsCa ? { tlsCa } : {}),
      }];
      if (input.server.authentication.kind === 'oauth_client_credentials') {
        const tokenEndpoint = input.server.authentication.tokenEndpoint;
        targets.push({
          url: tokenEndpoint,
          allowInternalNetwork,
          ...(tlsCa && new URL(tokenEndpoint).origin === endpointOrigin ? { tlsCa } : {}),
        });
      }
      const secureFetch = secureFetchFactory({
        targets,
        connectTimeoutMs: input.connectTimeoutMs,
        requestTimeoutMs: input.requestTimeoutMs,
        maxResponseBytes: input.maxDynamicOutputBytes,
        ...(options.dnsResolver ? { dnsResolver: options.dnsResolver } : {}),
      });
      const authentication = createMcpTransportAuthentication({
        config: input.server.authentication,
        credentialVault: options.credentialVault,
        fetch: secureFetch.fetch,
      });
      const client = new Client(
        { name: 'psfn-mcp-gateway', version: '0.1.0' },
        {
          enforceStrictCapabilities: true,
          inputRequired: { autoFulfill: false },
          listMaxPages: input.maxPaginationPages,
          defaultCacheTtlMs: 0,
          cachePartition: input.companionId,
          versionNegotiation: {
            mode: 'auto',
            probe: { timeoutMs: input.connectTimeoutMs, maxRetries: 0 },
          },
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => input.onToolsChanged(),
            },
          },
        },
      );
      const transport = new StreamableHTTPClientTransport(new URL(input.server.endpoint), {
        fetch: secureFetch.fetch,
        onInsufficientScope: 'throw',
        maxStepUpRetries: 0,
        ...(authentication.authProvider ? { authProvider: authentication.authProvider } : {}),
        ...(authentication.requestInit ? { requestInit: authentication.requestInit } : {}),
      });
      try {
        await client.connect(transport, {
          timeout: input.connectTimeoutMs,
          maxTotalTimeout: input.connectTimeoutMs,
        });
      } catch (error) {
        await Promise.allSettled([client.close(), secureFetch.close()]);
        throw error;
      }

      return {
        async listTools(listInput) {
          return client.listTools(undefined, {
            timeout: listInput.timeoutMs,
            cacheMode: 'refresh',
            ...(listInput.signal ? { signal: listInput.signal } : {}),
          });
        },
        async callTool(callInput) {
          return client.callTool({
            name: callInput.name,
            arguments: callInput.arguments,
          }, {
            timeout: callInput.timeoutMs,
            toolDefinition: callInput.toolDefinition as Tool,
            ...(callInput.signal ? { signal: callInput.signal } : {}),
          });
        },
        close: () => closeBoth(client, secureFetch),
      };
    },
  };
}
