import { createHash } from 'node:crypto';
import { fetch as undiciFetch, type Agent, type Dispatcher } from 'undici';
import { createPinnedAddressAgent } from '../pinned-address-agent.js';
import {
  checkResolvedIP,
  evaluateUrlPolicy,
  type DnsResolver,
} from '../url-policy.js';

export interface McpSecureFetchTarget {
  url: string;
  allowInternalNetwork: boolean;
  /** Optional operator-supplied PEM bundle for a private TLS authority. */
  tlsCa?: string;
}

type McpFetchInit = RequestInit & { dispatcher?: Dispatcher };
export type McpNetworkFetch = (
  input: string | URL | Request,
  init?: McpFetchInit,
) => Promise<Response>;

export interface McpSecureFetchController {
  fetch: typeof fetch;
  close(): Promise<void>;
}

function normalizedUrl(input: string | URL | Request): string {
  const raw = input instanceof Request ? input.url : input.toString();
  const parsed = new URL(raw);
  parsed.hash = '';
  return parsed.toString();
}

function targetKey(target: McpSecureFetchTarget, address: string): string {
  const caHash = target.tlsCa
    ? createHash('sha256').update(target.tlsCa, 'utf8').digest('hex')
    : '';
  return JSON.stringify([new URL(target.url).origin, address, caHash]);
}

export function createMcpSecureFetchController(options: {
  targets: McpSecureFetchTarget[];
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  dnsResolver?: DnsResolver;
  networkFetch?: McpNetworkFetch;
}): McpSecureFetchController {
  const targets = new Map<string, McpSecureFetchTarget>();
  for (const target of options.targets) {
    const url = normalizedUrl(target.url);
    if (targets.has(url)) throw new Error(`Duplicate MCP secure-fetch target '${url}'`);
    targets.set(url, { ...target, url });
  }
  const dispatchers = new Map<string, Agent>();
  const networkFetch: McpNetworkFetch = options.networkFetch
    ?? (undiciFetch as unknown as McpNetworkFetch);
  let closed = false;

  const secureFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (closed) throw new Error('MCP secure fetch is closed');
    const url = normalizedUrl(input);
    const target = targets.get(url);
    if (!target) throw new Error(`MCP request URL is not allowlisted: ${url}`);

    const parsed = new URL(url);
    const policy = evaluateUrlPolicy(url, {
      allowHttp: false,
      allowInternalNetwork: target.allowInternalNetwork,
      hostAllowlist: [parsed.host],
      maxRedirectHops: 0,
    });
    if (!policy.allowed) throw new Error(`MCP request URL blocked: ${policy.reason}`);

    const dns = await checkResolvedIP(parsed.hostname, options.dnsResolver, {
      allowPrivateResolvedIp: target.allowInternalNetwork,
    });
    if (!dns.allowed || !dns.address) {
      throw new Error(`MCP request URL blocked: ${dns.reason ?? 'DNS yielded no usable address'}`);
    }

    const key = targetKey(target, dns.address);
    let dispatcher = dispatchers.get(key);
    if (!dispatcher) {
      dispatcher = createPinnedAddressAgent({
        address: dns.address,
        connectTimeoutMs: options.connectTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        maxOrigins: options.targets.length,
        ...(target.tlsCa ? { tlsCa: target.tlsCa } : {}),
      });
      dispatchers.set(key, dispatcher);
    }

    return networkFetch(input, {
      ...init,
      redirect: 'error',
      dispatcher,
    });
  };

  return {
    fetch: secureFetch as typeof fetch,
    async close() {
      if (closed) return;
      closed = true;
      const agents = [...dispatchers.values()];
      dispatchers.clear();
      const results = await Promise.allSettled(agents.map(agent => agent.close()));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'Failed to close MCP TLS dispatchers');
    },
  };
}
