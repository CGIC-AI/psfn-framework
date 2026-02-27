import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { sanitizeWebContent } from '../sanitize.js';
import {
  evaluateUrlPolicy,
  checkResolvedIP,
  type UrlPolicyConfig,
  type UrlPolicyLane,
} from '../url-policy.js';
import { GatewayErrors, type WebFetchParams } from '../protocol.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { createComponentLogger } from '../../logger.js';
import {
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_USER_AGENT,
} from '../../security/policy-constants.js';
import { registerGatedDescriptors } from './register.js';

const log = createComponentLogger('GatewayWeb');
const tlsBundleCache = new Map<string, string>();

interface ResponseLike {
  status: number;
  statusText: string;
  ok: boolean;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

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
  return value === 'local_crawler'
    ? 'local_crawler'
    : 'default';
}

function resolveUrlPolicyConfig(runtime: GatewayMethodRuntime): UrlPolicyConfig {
  if (runtime.policyConfig.urlPolicy) {
    return runtime.policyConfig.urlPolicy;
  }

  // Backward-compatible env fallback for direct gateway method registration in tests.
  const fallback: UrlPolicyConfig = {
    allowHttp: process.env.ALLOW_HTTP_FETCH === 'true',
    domainAllowlist: process.env.FETCH_DOMAIN_ALLOWLIST
      ? process.env.FETCH_DOMAIN_ALLOWLIST.split(',').map(d => d.trim()).filter(Boolean)
      : undefined,
  };
  runtime.policyConfig.urlPolicy = fallback;
  return fallback;
}

function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = [...new Set(
    value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )];
  return parsed.length > 0 ? parsed : undefined;
}

function resolveTlsCertPaths(runtime: GatewayMethodRuntime): string[] {
  const configured = runtime.policyConfig.webFetchTlsCaCertPaths;
  if (configured && configured.length > 0) {
    return configured;
  }

  return parseCsvEnv(process.env.FETCH_TLS_CA_CERT_PATHS) ?? [];
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

async function requestText(
  url: string,
  options: { tlsCaBundle?: string },
): Promise<ResponseLike> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const requestImpl = isHttps ? httpsRequest : httpRequest;

  return await new Promise<ResponseLike>((resolveResponse, rejectResponse) => {
    const req = requestImpl(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': WEB_FETCH_USER_AGENT,
        },
        ...(isHttps && options.tlsCaBundle ? {
          ca: [...rootCertificates, options.tlsCaBundle],
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
          const body = Buffer.concat(chunks).toString('utf8');
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
              return body;
            },
          });
        });
      },
    );

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
  const dnsCheck = await checkResolvedIP(parsed.hostname, undefined, {
    allowPrivateResolvedIp: lane === 'local_crawler',
  });
  if (!dnsCheck.allowed) {
    log.warn(`DNS resolution blocked fetch: ${dnsCheck.reason} (${url})`);
    throw new JSONRPCErrorException(
      `URL blocked: ${dnsCheck.reason}`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  try {
    return await requestText(url, {
      tlsCaBundle,
    });
  } catch (err) {
    throw new JSONRPCErrorException(
      formatFetchProviderError(err),
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

const webDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'web.fetch',
    handler: async (params: WebFetchParams, runtime) => {
      const lane = toLane(params.lane);
      const urlPolicyConfig = resolveUrlPolicyConfig(runtime);

      let tlsCaBundle: string | undefined;
      try {
        tlsCaBundle = loadTlsBundle(resolveTlsCertPaths(runtime));
      } catch (err) {
        throw new JSONRPCErrorException(
          `Fetch TLS setup failed: ${formatFetchFailureDetails(err)}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const response = await fetchWithPolicyChecks(
        params.url,
        lane,
        urlPolicyConfig,
        tlsCaBundle,
      );

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new JSONRPCErrorException('Redirect with no Location header', GatewayErrors.PROVIDER_ERROR);
        }

        const redirectUrl = new URL(location, params.url).href;
        const redirectResponse = await fetchWithPolicyChecks(
          redirectUrl,
          lane,
          urlPolicyConfig,
          tlsCaBundle,
        );
        if (!redirectResponse.ok) {
          throw new JSONRPCErrorException(
            `Fetch failed after redirect: ${redirectResponse.status} ${redirectResponse.statusText}`,
            GatewayErrors.PROVIDER_ERROR,
          );
        }

        const rawRedirectContent = await redirectResponse.text();
        const redirectResult = sanitizeWebContent(rawRedirectContent, redirectUrl);
        if (redirectResult.injectionPatternsFound > 0) {
          log.warn(`Sanitized ${redirectResult.injectionPatternsFound} injection patterns from ${redirectUrl}`);
        }
        return { content: redirectResult.content, sanitized: redirectResult.sanitized };
      }

      if (!response.ok) {
        throw new JSONRPCErrorException(
          `Fetch failed: ${response.status} ${response.statusText}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }
      const rawContent = await response.text();
      const result = sanitizeWebContent(rawContent, params.url);
      if (result.injectionPatternsFound > 0) {
        log.warn(`Sanitized ${result.injectionPatternsFound} injection patterns from ${params.url}`);
      }
      return { content: result.content, sanitized: result.sanitized };
    },
    summary: (p: WebFetchParams) => ({ url: p.url, lane: toLane(p.lane) }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchParams) => `${toLane(p.lane)}:${p.url}`,
  },
];

export function registerWebMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, webDescriptors);
}
