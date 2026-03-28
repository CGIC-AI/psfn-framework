import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { sanitizeWebContent } from '../sanitize.js';
import {
  evaluateUrlPolicy,
  checkResolvedIP,
  resolveMaxRedirectHops,
  type DnsResolver,
  type UrlPolicyConfig,
  type UrlPolicyLane,
} from '../url-policy.js';
import {
  GatewayErrors,
  type WebFetchBinaryParams,
  type WebFetchParams,
  type WebRequestBinaryParams,
} from '../protocol.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_USER_AGENT,
} from '../../../system/security/policy-constants.js';
import { registerGatedDescriptors } from './register.js';

const log = createComponentLogger('GatewayWeb');
const tlsBundleCache = new Map<string, string>();
const WEB_FETCH_BINARY_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

interface ResponseLike {
  status: number;
  statusText: string;
  ok: boolean;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface WebPolicyTestHooks {
  webFetchDnsResolver?: DnsResolver;
}

type WebFetchMethodName = 'web.fetch' | 'web.fetch_binary' | 'web.request_binary';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || !err) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function formatFetchFailureDetails(err: unknown): string {
  const topMessage = getErrorMessage(err);
  const topCode = getErrorCode(err);

  let causeMessage: string | undefined;
  let causeCode: string | undefined;
  if (typeof err === 'object' && err && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    causeMessage = getErrorMessage(cause);
    causeCode = getErrorCode(cause);
  }

  const segments = [topMessage];
  if (topCode) segments.push(`code=${topCode}`);
  if (causeCode) segments.push(`cause_code=${causeCode}`);
  if (causeMessage && causeMessage !== topMessage) segments.push(`cause=${causeMessage}`);
  return segments.filter(Boolean).join(' | ');
}

function formatFetchProviderError(err: unknown): string {
  const details = formatFetchFailureDetails(err);
  const normalized = details.toUpperCase();
  const looksLikeTls =
    normalized.includes('CERT') ||
    normalized.includes('SSL') ||
    normalized.includes('TLS') ||
    normalized.includes('UNABLE_TO_GET_ISSUER');
  if (looksLikeTls) {
    return `Fetch TLS failure: ${details}`;
  }
  if (normalized.includes('TIMEOUT') || normalized.includes('ABORT')) {
    return `Fetch timeout: ${details}`;
  }
  return `Fetch failed: ${details}`;
}

function toLane(value: unknown): UrlPolicyLane {
  if (value === 'local_crawler') return 'local_crawler';
  if (value === 'discovery') return 'discovery';
  return 'default';
}

function normalizeBinaryMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return WEB_FETCH_BINARY_MAX_BYTES_DEFAULT;
  }
  return Math.max(1, Math.floor(value));
}

function resolveUrlPolicyConfig(runtime: GatewayMethodRuntime): UrlPolicyConfig {
  if (runtime.policyConfig.urlPolicy) {
    return runtime.policyConfig.urlPolicy;
  }

  const fallback: UrlPolicyConfig = {};
  runtime.policyConfig.urlPolicy = fallback;
  return fallback;
}

function resolveDnsResolver(runtime: GatewayMethodRuntime): DnsResolver | undefined {
  return (runtime.policyConfig as WebPolicyTestHooks).webFetchDnsResolver;
}

function resolveTlsCertPaths(runtime: GatewayMethodRuntime): string[] {
  const configured = runtime.policyConfig.webFetchTlsCaCertPaths;
  if (configured && configured.length > 0) {
    return configured;
  }

  return [];
}

function loadTlsBundle(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;

  const normalized = paths
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => isAbsolute(path) ? path : resolve(process.cwd(), path));
  if (normalized.length === 0) return undefined;

  const cacheKey = normalized.join('|');
  const cached = tlsBundleCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const certParts = normalized.map(path => readFileSync(path, 'utf8'));
  const bundle = certParts.join('\n');
  tlsBundleCache.set(cacheKey, bundle);
  return bundle;
}

function normalizeRequestHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return {};

  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    const headerName = name.trim();
    if (!headerName) continue;
    if (/^host$/i.test(headerName) || /^content-length$/i.test(headerName)) {
      continue;
    }
    if (typeof value !== 'string') continue;
    const headerValue = value.trim();
    if (!headerValue) continue;
    normalized[headerName] = headerValue;
  }
  return normalized;
}

function normalizeRequestMethod(value: unknown): string {
  if (typeof value !== 'string') return 'GET';
  const trimmed = value.trim();
  if (!trimmed) return 'GET';
  if (!/^[A-Z0-9!#$%&'*+.^_`|~-]+$/i.test(trimmed)) {
    throw new JSONRPCErrorException('Invalid HTTP method', GatewayErrors.POLICY_DENIED);
  }
  return trimmed.toUpperCase();
}

async function requestText(
  url: string,
  options: {
    tlsCaBundle?: string;
    connectAddress?: string;
    headers?: Record<string, string>;
    method?: string;
    body?: Buffer;
  },
): Promise<ResponseLike> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const requestImpl = isHttps ? httpsRequest : httpRequest;
  const method = normalizeRequestMethod(options.method);
  const originalHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const shouldSetServername = isHttps
    && typeof options.connectAddress === 'string'
    && options.connectAddress.length > 0
    && isIP(originalHostname) === 0;
  const headers: Record<string, string> = {
    ...normalizeRequestHeaders(options.headers),
    'User-Agent': WEB_FETCH_USER_AGENT,
  };
  if (options.connectAddress) {
    headers.Host = parsed.host;
  }

  return await new Promise<ResponseLike>((resolveResponse, rejectResponse) => {
    const req = requestImpl(
      {
        protocol: parsed.protocol,
        hostname: options.connectAddress ?? parsed.hostname,
        family: options.connectAddress ? isIP(options.connectAddress) : undefined,
        port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        ...(isHttps && options.tlsCaBundle ? {
          ca: [...rootCertificates, options.tlsCaBundle],
        } : {}),
        ...(shouldSetServername ? {
          servername: originalHostname,
        } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', rejectResponse);
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          const headers = new Map<string, string>();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              headers.set(name.toLowerCase(), value.join(', '));
            } else if (typeof value === 'string') {
              headers.set(name.toLowerCase(), value);
            }
          }

          resolveResponse({
            status,
            statusText: res.statusMessage ?? '',
            ok: status >= 200 && status < 300,
            headers: {
              get(name: string): string | null {
                return headers.get(name.toLowerCase()) ?? null;
              },
            },
            async text() {
              return body.toString('utf8');
            },
            async arrayBuffer() {
              return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
            },
          });
        });
      },
    );

    if (options.body && options.body.byteLength > 0) {
      req.write(options.body);
    }

    const timeout = setTimeout(() => {
      const timeoutError = new Error(`Request timed out after ${WEB_FETCH_TIMEOUT_MS}ms`);
      (timeoutError as { code?: string }).code = 'ETIMEDOUT';
      req.destroy(timeoutError);
    }, WEB_FETCH_TIMEOUT_MS);

    req.on('error', (err) => {
      clearTimeout(timeout);
      rejectResponse(err);
    });
    req.on('close', () => {
      clearTimeout(timeout);
    });
    req.end();
  });
}

async function fetchWithPolicyChecks(
  url: string,
  lane: UrlPolicyLane,
  urlPolicyConfig: UrlPolicyConfig,
  tlsCaBundle: string | undefined,
  requestHeaders: Record<string, string>,
  requestMethod?: string,
  requestBody?: Buffer,
  dnsResolver?: DnsResolver,
): Promise<ResponseLike> {
  const urlCheck = evaluateUrlPolicy(url, urlPolicyConfig, lane);
  if (!urlCheck.allowed) {
    log.warn(`URL policy blocked fetch: ${urlCheck.reason} (${url})`);
    throw new JSONRPCErrorException(
      `URL blocked: ${urlCheck.reason}`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  const parsed = new URL(url);
  const dnsCheck = await checkResolvedIP(parsed.hostname, dnsResolver, {
    allowPrivateResolvedIp:
      lane === 'local_crawler'
      || lane === 'discovery'
      || urlPolicyConfig.allowInternalNetwork === true,
  });
  if (!dnsCheck.allowed) {
    log.warn(`DNS resolution blocked fetch: ${dnsCheck.reason} (${url})`);
    throw new JSONRPCErrorException(
      `URL blocked: ${dnsCheck.reason}`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  const connectAddress = dnsCheck.address;
  if (!connectAddress) {
    throw new JSONRPCErrorException(
      'URL blocked: DNS resolution did not return a usable address',
      GatewayErrors.POLICY_DENIED,
    );
  }

  try {
    return await requestText(url, {
      tlsCaBundle,
      connectAddress,
      headers: requestHeaders,
      method: requestMethod,
      body: requestBody,
    });
  } catch (err) {
    throw new JSONRPCErrorException(
      formatFetchProviderError(err),
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

interface RedirectChainFetchResult {
  response: ResponseLike;
  finalUrl: string;
  redirectHopCount: number;
  redirectChain: string[];
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

function recordRedirectChainAudit(
  runtime: GatewayMethodRuntime,
  event: {
    rpcMethod: WebFetchMethodName;
    lane: UrlPolicyLane;
    originUrl: string;
    finalUrl: string;
    redirectHopCount: number;
    redirectChain: string[];
    outcome: 'success' | 'error';
  },
  durationMs: number,
  error?: string,
): void {
  runtime.recordAuditEvent?.({
    method: 'web.fetch.redirect_chain',
    decision: event.outcome === 'success' ? 'ALLOW' : 'DENY',
    params: event,
    durationMs,
    ...(error ? { error } : {}),
  });
}

async function fetchWithValidatedRedirectChain(
  rpcMethod: WebFetchMethodName,
  originUrl: string,
  lane: UrlPolicyLane,
  urlPolicyConfig: UrlPolicyConfig,
  tlsCaBundle: string | undefined,
  requestHeaders: Record<string, string>,
  requestMethod: string | undefined,
  requestBody: Buffer | undefined,
  runtime: GatewayMethodRuntime,
  dnsResolver?: DnsResolver,
): Promise<RedirectChainFetchResult> {
  const maxRedirectHops = resolveMaxRedirectHops(urlPolicyConfig);
  let currentUrl = originUrl;
  let redirectHopCount = 0;
  const redirectChain = [originUrl];
  const visited = new Set<string>(redirectChain);
  const startedAt = Date.now();

  try {
    for (;;) {
      const response = await fetchWithPolicyChecks(
        currentUrl,
        lane,
        urlPolicyConfig,
        tlsCaBundle,
        requestHeaders,
        requestMethod,
        requestBody,
        dnsResolver,
      );
      if (!isRedirectStatus(response.status)) {
        if (redirectHopCount > 0) {
          recordRedirectChainAudit(runtime, {
            rpcMethod,
            lane,
            originUrl,
            finalUrl: currentUrl,
            redirectHopCount,
            redirectChain: [...redirectChain],
            outcome: 'success',
          }, Date.now() - startedAt);
        }
        return {
          response,
          finalUrl: currentUrl,
          redirectHopCount,
          redirectChain: [...redirectChain],
        };
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new JSONRPCErrorException(
          'Fetch failed: redirect response missing Location header',
          GatewayErrors.PROVIDER_ERROR,
        );
      }
      if (redirectHopCount >= maxRedirectHops) {
        throw new JSONRPCErrorException(
          `Fetch failed: redirect chain exceeded ${maxRedirectHops} hops`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentUrl).href;
      } catch {
        throw new JSONRPCErrorException(
          `Fetch failed: invalid redirect location ${location}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      if (visited.has(redirectUrl)) {
        throw new JSONRPCErrorException(
          `Fetch failed: redirect loop detected at ${redirectUrl}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      visited.add(redirectUrl);
      redirectChain.push(redirectUrl);
      redirectHopCount += 1;
      currentUrl = redirectUrl;
    }
  } catch (err) {
    if (redirectHopCount > 0) {
      recordRedirectChainAudit(runtime, {
        rpcMethod,
        lane,
        originUrl,
        finalUrl: currentUrl,
        redirectHopCount,
        redirectChain: [...redirectChain],
        outcome: 'error',
      }, Date.now() - startedAt, getErrorMessage(err));
    }
    throw err;
  }
}

const webDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'web.fetch',
    handler: async (params: WebFetchParams, runtime) => {
      const lane = toLane(params.lane);
      const urlPolicyConfig = resolveUrlPolicyConfig(runtime);
      const dnsResolver = resolveDnsResolver(runtime);

      let tlsCaBundle: string | undefined;
      try {
        tlsCaBundle = loadTlsBundle(resolveTlsCertPaths(runtime));
      } catch (err) {
        throw new JSONRPCErrorException(
          `Fetch TLS setup failed: ${formatFetchFailureDetails(err)}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const { response, finalUrl } = await fetchWithValidatedRedirectChain(
        'web.fetch',
        params.url,
        lane,
        urlPolicyConfig,
        tlsCaBundle,
        {},
        undefined,
        undefined,
        runtime,
        dnsResolver,
      );

      if (!response.ok) {
        throw new JSONRPCErrorException(
          `Fetch failed: ${response.status} ${response.statusText}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }
      const rawContent = await response.text();
      const result = sanitizeWebContent(rawContent, finalUrl);
      if (result.injectionPatternsFound > 0) {
        log.warn(`Sanitized ${result.injectionPatternsFound} injection patterns from ${finalUrl}`);
      }
      return { content: result.content, sanitized: result.sanitized };
    },
    summary: (p: WebFetchParams) => ({ url: p.url, lane: toLane(p.lane) }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchParams) => `${toLane(p.lane)}:${p.url}`,
  },
  {
    name: 'web.fetch_binary',
    handler: async (params: WebFetchBinaryParams, runtime) => {
      const lane = toLane(params.lane);
      const urlPolicyConfig = resolveUrlPolicyConfig(runtime);
      const maxBytes = normalizeBinaryMaxBytes(params.maxBytes);
      const dnsResolver = resolveDnsResolver(runtime);
      const requestHeaders = normalizeRequestHeaders(params.headers);

      let tlsCaBundle: string | undefined;
      try {
        tlsCaBundle = loadTlsBundle(resolveTlsCertPaths(runtime));
      } catch (err) {
        throw new JSONRPCErrorException(
          `Fetch TLS setup failed: ${formatFetchFailureDetails(err)}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const { response } = await fetchWithValidatedRedirectChain(
        'web.fetch_binary',
        params.url,
        lane,
        urlPolicyConfig,
        tlsCaBundle,
        requestHeaders,
        undefined,
        undefined,
        runtime,
        dnsResolver,
      );

      if (!response.ok) {
        throw new JSONRPCErrorException(
          `Fetch failed: ${response.status} ${response.statusText}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const reportedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(reportedLength) && reportedLength > maxBytes) {
        throw new JSONRPCErrorException(
          `Fetch binary payload too large: ${reportedLength} bytes exceeds ${maxBytes}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        throw new JSONRPCErrorException(
          `Fetch binary payload too large: ${bytes.length} bytes exceeds ${maxBytes}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream')
        .split(';')[0]
        .trim()
        .toLowerCase();

      return {
        dataBase64: bytes.toString('base64'),
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes: bytes.length,
      };
    },
    summary: (p: WebFetchBinaryParams) => ({
      url: p.url,
      lane: toLane(p.lane),
      maxBytes: normalizeBinaryMaxBytes(p.maxBytes),
    }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchBinaryParams) => `${toLane(p.lane)}:${p.url}`,
  },
  {
    name: 'web.request_binary',
    handler: async (params: WebRequestBinaryParams, runtime) => {
      const lane = toLane(params.lane);
      const urlPolicyConfig = resolveUrlPolicyConfig(runtime);
      const maxBytes = normalizeBinaryMaxBytes(params.maxBytes);
      const dnsResolver = resolveDnsResolver(runtime);
      const requestHeaders = normalizeRequestHeaders(params.headers);
      const requestMethod = normalizeRequestMethod(params.method);
      const requestBody = params.bodyBase64
        ? Buffer.from(params.bodyBase64, 'base64')
        : undefined;

      let tlsCaBundle: string | undefined;
      try {
        tlsCaBundle = loadTlsBundle(resolveTlsCertPaths(runtime));
      } catch (err) {
        throw new JSONRPCErrorException(
          `Fetch TLS setup failed: ${formatFetchFailureDetails(err)}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const { response } = await fetchWithValidatedRedirectChain(
        'web.request_binary',
        params.url,
        lane,
        urlPolicyConfig,
        tlsCaBundle,
        requestHeaders,
        requestMethod,
        requestBody,
        runtime,
        dnsResolver,
      );

      const reportedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(reportedLength) && reportedLength > maxBytes) {
        throw new JSONRPCErrorException(
          `Fetch binary payload too large: ${reportedLength} bytes exceeds ${maxBytes}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        throw new JSONRPCErrorException(
          `Fetch binary payload too large: ${bytes.length} bytes exceeds ${maxBytes}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream')
        .split(';')[0]
        .trim()
        .toLowerCase();

      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        dataBase64: bytes.toString('base64'),
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes: bytes.length,
      };
    },
    summary: (p: WebRequestBinaryParams) => ({
      url: p.url,
      lane: toLane(p.lane),
      method: normalizeRequestMethod(p.method),
      maxBytes: normalizeBinaryMaxBytes(p.maxBytes),
    }),
    approvalAction: 'fetch',
    approvalScope: (p: WebRequestBinaryParams) => `${toLane(p.lane)}:${normalizeRequestMethod(p.method)}:${p.url}`,
  },
];

export function registerWebMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, webDescriptors);
}
