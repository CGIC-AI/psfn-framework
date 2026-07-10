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
  type WebIntakeScreeningSummary,
  type WebRequestBinaryParams,
  type WebSearchParams,
} from '../protocol.js';
import type { IntakeSourceClass } from '../../../shared/contracts/intake-envelope.js';
import type { WebBackendPolicy } from '../policy.js';
import {
  normalizeSearchMaxResults,
  openRouterWebFetch,
  openRouterWebSearch,
} from './openrouter-web.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_USER_AGENT,
} from '../../../system/security/policy-constants.js';
import { registerGatedDescriptors } from './register.js';
import {
  type CircuitBreakerTransition,
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from '../../../shared/resilience/circuit-breaker.js';

const log = createComponentLogger('GatewayWeb');
const tlsBundleCache = new Map<string, string>();
const WEB_FETCH_BINARY_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
/** Hard cap for the text fetch lane (Sprint-10 H2): the text lane previously
 *  buffered unbounded response bodies. Enforced DURING streaming. */
export const WEB_FETCH_TEXT_MAX_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
/** Headers that must not survive an origin-changing redirect (Sprint-10 01-M1). */
const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
const WEB_CIRCUIT_BREAKER = new SlidingWindowCircuitBreaker({
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export interface ResponseLike {
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
export type WebCircuitMethodName =
  | WebFetchMethodName
  | 'home_assistant.get_states'
  | 'home_assistant.call_service'
  | 'home_assistant.check_connection';

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

export function formatFetchFailureDetails(err: unknown): string {
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

function normalizeWebCircuitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function webCircuitKey(method: WebCircuitMethodName, lane: UrlPolicyLane, url: string): string {
  return `${method}::${lane}::${normalizeWebCircuitUrl(url)}`;
}

function isProviderJsonRpcError(error: Error): boolean {
  return error instanceof JSONRPCErrorException
    && error.code === GatewayErrors.PROVIDER_ERROR;
}

function toCircuitOpenJsonRpcError(error: CircuitOpenError): JSONRPCErrorException {
  return new JSONRPCErrorException(
    error.message,
    GatewayErrors.PROVIDER_ERROR,
    {
      code: error.code,
      circuitKey: error.circuitKey,
      method: error.method,
      state: error.state,
      failureCount: error.failureCount,
      failureThreshold: error.failureThreshold,
      windowMs: error.windowMs,
      cooldownMs: error.cooldownMs,
      openedAtMs: error.openedAtMs,
      openUntilMs: error.openUntilMs,
    },
  );
}

function logWebCircuitTransition(transition: CircuitBreakerTransition): void {
  const payload = {
    method: transition.method,
    circuitKey: transition.key,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    failureCount: transition.failureCount,
    failureThreshold: transition.failureThreshold,
    windowMs: transition.windowMs,
    cooldownMs: transition.cooldownMs,
    ...(transition.openUntilMs !== undefined ? {
      openUntil: new Date(transition.openUntilMs).toISOString(),
    } : {}),
    ...(transition.lastError ? { lastError: transition.lastError } : {}),
  };

  if (transition.to === 'open') {
    log.warn('Web fetch circuit breaker opened', payload);
    return;
  }
  log.info('Web fetch circuit breaker state changed', payload);
}

export async function withWebCircuit<T>(
  method: WebCircuitMethodName,
  lane: UrlPolicyLane,
  url: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await WEB_CIRCUIT_BREAKER.execute({
      key: webCircuitKey(method, lane, url),
      method,
      operation,
      shouldRecordFailure: isProviderJsonRpcError,
      onTransition: logWebCircuitTransition,
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      throw toCircuitOpenJsonRpcError(error);
    }
    throw error;
  }
}

export function resetWebCircuitBreakersForTests(): void {
  WEB_CIRCUIT_BREAKER.reset();
}

function parseLane(value: unknown): UrlPolicyLane | null {
  if (value === undefined || value === null || value === '' || value === 'default') return 'default';
  if (value === 'local_crawler') return 'local_crawler';
  if (value === 'discovery') return 'discovery';
  return null;
}

function describeLane(value: unknown): string {
  const lane = parseLane(value);
  return lane ?? `invalid:${String(value)}`;
}

function requireLane(value: unknown): UrlPolicyLane {
  const lane = parseLane(value);
  if (!lane) {
    throw new JSONRPCErrorException(
      `Unsupported web lane: ${String(value)}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  return lane;
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

export function resolveDnsResolver(runtime: GatewayMethodRuntime): DnsResolver | undefined {
  return (runtime.policyConfig as WebPolicyTestHooks).webFetchDnsResolver;
}

export function resolveTlsCertPaths(runtime: GatewayMethodRuntime): string[] {
  const configured = runtime.policyConfig.webFetchTlsCaCertPaths;
  if (configured && configured.length > 0) {
    return configured;
  }

  return [];
}

export function loadTlsBundle(paths: readonly string[]): string | undefined {
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

export function normalizeRequestHeaders(raw: unknown): Record<string, string> {
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
    /** Hard response-body cap enforced while streaming (Sprint-10 H2).
     *  Never trusts content-length: cumulative received bytes are counted and
     *  the socket is destroyed the moment the cap is exceeded. */
    maxBodyBytes: number;
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
        let receivedBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          receivedBytes += buffer.byteLength;
          if (receivedBytes > options.maxBodyBytes) {
            const capError = new Error(
              `Response body too large: exceeded ${options.maxBodyBytes} bytes`,
            );
            (capError as { code?: string }).code = 'EMSGSIZE';
            // Reject first so the deterministic cap error wins, then destroy
            // the socket without an error argument: the teardown noise
            // (ECONNRESET/premature close) is routed to the existing
            // req/res error listeners and the promise is already settled.
            rejectResponse(capError);
            req.destroy();
            return;
          }
          chunks.push(buffer);
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
  requestMethod: string | undefined,
  requestBody: Buffer | undefined,
  maxResponseBytes: number,
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
      maxBodyBytes: maxResponseBytes,
    });
  } catch (err) {
    throw new JSONRPCErrorException(
      formatFetchProviderError(err),
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

export interface RedirectChainFetchResult {
  response: ResponseLike;
  finalUrl: string;
  redirectHopCount: number;
  redirectChain: string[];
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

// ── Redirect credential hygiene (Sprint-10 01-M1) ──
// A redirect that changes scheme, host, or (effective) port leaves the
// original request origin; agent-supplied Authorization/Cookie material must
// not be replayed to the new origin. Once stripped, headers stay stripped for
// the rest of the chain (a bounce back to the first origin does not restore
// them — the intermediate origin controlled the chain).

function effectiveRedirectPort(parsed: URL): string {
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

function isSameRequestOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol
    && a.hostname === b.hostname
    && effectiveRedirectPort(a) === effectiveRedirectPort(b);
}

function stripSensitiveRedirectHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())),
  );
}

async function recordRedirectChainAudit(
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
): Promise<void> {
  await runtime.recordAuditEvent?.({
    method: 'web.fetch.redirect_chain',
    decision: event.outcome === 'success' ? 'ALLOW' : 'DENY',
    params: event,
    durationMs,
    ...(error ? { error } : {}),
  });
}

export async function fetchWithValidatedRedirectChain(
  rpcMethod: WebCircuitMethodName,
  originUrl: string,
  lane: UrlPolicyLane,
  urlPolicyConfig: UrlPolicyConfig,
  tlsCaBundle: string | undefined,
  requestHeaders: Record<string, string>,
  requestMethod: string | undefined,
  requestBody: Buffer | undefined,
  maxResponseBytes: number,
  runtime: GatewayMethodRuntime,
  dnsResolver?: DnsResolver,
): Promise<RedirectChainFetchResult> {
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes < 1) {
    throw new JSONRPCErrorException(
      'Fetch failed: maxResponseBytes must be a positive byte cap',
      GatewayErrors.POLICY_DENIED,
    );
  }
  const maxRedirectHops = resolveMaxRedirectHops(urlPolicyConfig);
  let currentUrl = originUrl;
  let currentHeaders = requestHeaders;
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
        currentHeaders,
        requestMethod,
        requestBody,
        maxResponseBytes,
        dnsResolver,
      );
      if (!isRedirectStatus(response.status)) {
        if (redirectHopCount > 0) {
          await recordRedirectChainAudit(runtime, {
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

      // Drop credentials before re-issuing to a different origin (01-M1).
      // Both URLs are known-parseable here: redirectUrl was just built with
      // `new URL(...)` and currentUrl was successfully fetched.
      if (!isSameRequestOrigin(new URL(currentUrl), new URL(redirectUrl))) {
        currentHeaders = stripSensitiveRedirectHeaders(currentHeaders);
      }

      visited.add(redirectUrl);
      redirectChain.push(redirectUrl);
      redirectHopCount += 1;
      currentUrl = redirectUrl;
    }
  } catch (err) {
    if (redirectHopCount > 0) {
      await recordRedirectChainAudit(runtime, {
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

// ── Cognition intake firewall wiring (bead psfn-framework-htm9.2) ──
// Web content is screened AFTER sanitizeWebContent (regex strip stays as a
// first pass) and BEFORE returning to the agent. Shadow mode records the
// envelope decision in the gateway audit journal without altering content;
// enforce mode substitutes the screening's effectiveText, so quarantined
// pages never cross the RPC boundary into prompt/memory/emotion.
async function screenWebContent(
  runtime: GatewayMethodRuntime,
  input: {
    rpcMethod: 'web.fetch' | 'web.search';
    sourceClass: IntakeSourceClass;
    content: string;
    originRef: string;
  },
): Promise<{ content: string; sanitizedByIntake: boolean; intake?: WebIntakeScreeningSummary }> {
  const screening = runtime.intakeScreening;
  if (!screening) {
    return { content: input.content, sanitizedByIntake: false };
  }
  const startedAt = Date.now();
  const screened = await screening.screen(input.content, {
    sourceClass: input.sourceClass,
    origin: { ref: input.originRef.slice(0, 2048) },
    scope: 'context',
  });
  await runtime.recordAuditEvent?.({
    method: `${input.rpcMethod}.intake_screening`,
    decision: screened.withheld ? 'DENY' : 'ALLOW',
    params: {
      envelopeId: screened.envelope.id,
      originRef: input.originRef.slice(0, 2048),
      mode: screened.mode,
      action: screened.action,
      state: screened.envelope.state,
      riskLabels: [...screened.envelope.riskLabels],
      scores: screened.envelope.scores,
      withheld: screened.withheld,
      ...(screened.injectionScorerError ? { injectionScorerError: screened.injectionScorerError } : {}),
    },
    durationMs: Date.now() - startedAt,
  });
  return {
    content: screened.effectiveText,
    sanitizedByIntake: screened.effectiveText !== input.content,
    intake: {
      envelopeId: screened.envelope.id,
      action: screened.action,
      state: screened.envelope.state,
      riskLabels: [...screened.envelope.riskLabels],
      mode: screened.mode,
      withheld: screened.withheld,
    },
  };
}

// ── Web backend selection (bead psfn-framework-htm9.10) ──
// Explicit config selects the backend (providers.json openrouter.metadata.webTools);
// there is no silent fallback. Absent config preserves the self-hosted direct/
// crawler path so existing deployments and tests are unchanged.
function resolveWebBackend(runtime: GatewayMethodRuntime): WebBackendPolicy {
  return runtime.policyConfig.webBackend ?? { kind: 'self_hosted' };
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JSONRPCErrorException(
      'web.search requires a non-empty query',
      GatewayErrors.POLICY_DENIED,
    );
  }
  return value.trim();
}

// Route web.fetch through OpenRouter's web_fetch server tool. Results still pass
// sanitizeWebContent below; the caller then routes this sanitized output
// through the htm9.2 intake screening (screenWebContent) — do not return an
// unscreened path.
async function fetchViaOpenRouter(
  backend: Extract<WebBackendPolicy, { kind: 'openrouter' }>,
  params: WebFetchParams,
): Promise<{ content: string; sanitized: boolean }> {
  let rawContent: string;
  try {
    rawContent = await openRouterWebFetch(backend.openRouter, params.url, params.prompt);
  } catch (err) {
    throw new JSONRPCErrorException(
      formatFetchProviderError(err),
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  const result = sanitizeWebContent(rawContent, params.url);
  if (result.injectionPatternsFound > 0) {
    log.warn(`Sanitized ${result.injectionPatternsFound} injection patterns from ${params.url} (openrouter)`);
  }
  return { content: result.content, sanitized: result.sanitized };
}

const webDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'web.fetch',
    handler: async (params: WebFetchParams, runtime) => {
      const backend = resolveWebBackend(runtime);
      if (backend.kind === 'openrouter') {
        const fetched = await fetchViaOpenRouter(backend, params);
        const screened = await screenWebContent(runtime, {
          rpcMethod: 'web.fetch',
          sourceClass: 'web_fetch',
          content: fetched.content,
          originRef: params.url,
        });
        return {
          content: screened.content,
          sanitized: fetched.sanitized || screened.sanitizedByIntake,
          ...(screened.intake ? { intake: screened.intake } : {}),
        };
      }

      const lane = requireLane(params.lane);
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

      return await withWebCircuit('web.fetch', lane, params.url, async () => {
        const { response, finalUrl } = await fetchWithValidatedRedirectChain(
          'web.fetch',
          params.url,
          lane,
          urlPolicyConfig,
          tlsCaBundle,
          {},
          undefined,
          undefined,
          WEB_FETCH_TEXT_MAX_BYTES,
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
        const screened = await screenWebContent(runtime, {
          rpcMethod: 'web.fetch',
          sourceClass: 'web_fetch',
          content: result.content,
          originRef: finalUrl,
        });
        return {
          content: screened.content,
          sanitized: result.sanitized || screened.sanitizedByIntake,
          ...(screened.intake ? { intake: screened.intake } : {}),
        };
      });
    },
    summary: (p: WebFetchParams) => ({ url: p.url, lane: describeLane(p.lane) }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchParams) => `${describeLane(p.lane)}:${p.url}`,
  },
  {
    name: 'web.fetch_binary',
    handler: async (params: WebFetchBinaryParams, runtime) => {
      const lane = requireLane(params.lane);
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

      return await withWebCircuit('web.fetch_binary', lane, params.url, async () => {
        const { response } = await fetchWithValidatedRedirectChain(
          'web.fetch_binary',
          params.url,
          lane,
          urlPolicyConfig,
          tlsCaBundle,
          requestHeaders,
          undefined,
          undefined,
          maxBytes,
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
      });
    },
    summary: (p: WebFetchBinaryParams) => ({
      url: p.url,
      lane: describeLane(p.lane),
      maxBytes: normalizeBinaryMaxBytes(p.maxBytes),
    }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchBinaryParams) => `${describeLane(p.lane)}:${p.url}`,
  },
  {
    name: 'web.request_binary',
    handler: async (params: WebRequestBinaryParams, runtime) => {
      const lane = requireLane(params.lane);
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

      return await withWebCircuit('web.request_binary', lane, params.url, async () => {
        const { response } = await fetchWithValidatedRedirectChain(
          'web.request_binary',
          params.url,
          lane,
          urlPolicyConfig,
          tlsCaBundle,
          requestHeaders,
          requestMethod,
          requestBody,
          maxBytes,
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
      });
    },
    summary: (p: WebRequestBinaryParams) => ({
      url: p.url,
      lane: describeLane(p.lane),
      method: normalizeRequestMethod(p.method),
      maxBytes: normalizeBinaryMaxBytes(p.maxBytes),
    }),
    approvalAction: 'fetch',
    approvalScope: (p: WebRequestBinaryParams) => `${describeLane(p.lane)}:${normalizeRequestMethod(p.method)}:${p.url}`,
  },
  {
    // Web search via OpenRouter's web_search server tool (bead psfn-framework-htm9.10).
    // Only available when the OpenRouter web backend is explicitly configured;
    // self-hosted deployments keep discovery in the agent-side search planner
    // (no silent fallback here — this method fails closed).
    name: 'web.search',
    handler: async (params: WebSearchParams, runtime) => {
      const backend = resolveWebBackend(runtime);
      if (backend.kind !== 'openrouter') {
        throw new JSONRPCErrorException(
          'web.search backend not configured: enable OpenRouter web tools '
          + '(providers.json openrouter.metadata.webTools) to use gateway web search',
          GatewayErrors.PROVIDER_ERROR,
        );
      }
      const query = requireSearchQuery(params.query);
      const maxResults = normalizeSearchMaxResults(params.maxResults);

      let searchResult: Awaited<ReturnType<typeof openRouterWebSearch>>;
      try {
        searchResult = await openRouterWebSearch(backend.openRouter, query, maxResults);
      } catch (err) {
        throw new JSONRPCErrorException(
          formatFetchProviderError(err),
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      const result = sanitizeWebContent(searchResult.content, `search:${query}`);
      if (result.injectionPatternsFound > 0) {
        log.warn(`Sanitized ${result.injectionPatternsFound} injection patterns from web.search (openrouter)`);
      }
      const screened = await screenWebContent(runtime, {
        rpcMethod: 'web.search',
        sourceClass: 'web_search',
        content: result.content,
        originRef: `search:${query}`,
      });
      return {
        content: screened.content,
        sanitized: result.sanitized || screened.sanitizedByIntake,
        citations: searchResult.citations,
        ...(screened.intake ? { intake: screened.intake } : {}),
      };
    },
    summary: (p: WebSearchParams) => ({
      query: p.query,
      maxResults: normalizeSearchMaxResults(p.maxResults),
    }),
    approvalAction: 'fetch',
    approvalScope: (p: WebSearchParams) => `search:${typeof p.query === 'string' ? p.query : ''}`,
  },
];

export function registerWebMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, webDescriptors);
}
