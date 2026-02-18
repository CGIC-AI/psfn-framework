import { JSONRPCErrorException } from 'json-rpc-2.0';
import { sanitizeWebContent } from '../sanitize.js';
import {
  evaluateUrlPolicy,
  checkResolvedIP,
  type UrlPolicyConfig,
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

const webDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'web.fetch',
    handler: async (params: WebFetchParams, runtime) => {
      const urlPolicyConfig = runtime.policyConfig.urlPolicy ?? {};
      const urlCheck = evaluateUrlPolicy(params.url, urlPolicyConfig);
      if (!urlCheck.allowed) {
        log.warn(`URL policy blocked fetch: ${urlCheck.reason} (${params.url})`);
        throw new JSONRPCErrorException(
          `URL blocked: ${urlCheck.reason}`,
          GatewayErrors.POLICY_DENIED,
        );
      }

      const parsed = new URL(params.url);
      const dnsCheck = await checkResolvedIP(parsed.hostname);
      if (!dnsCheck.allowed) {
        log.warn(`DNS resolution blocked fetch: ${dnsCheck.reason} (${params.url})`);
        throw new JSONRPCErrorException(
          `URL blocked: ${dnsCheck.reason}`,
          GatewayErrors.POLICY_DENIED,
        );
      }

      let response: Response;
      try {
        response = await fetch(params.url, {
          headers: { 'User-Agent': WEB_FETCH_USER_AGENT },
          signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
          redirect: 'manual',
        });
      } catch (err) {
        throw new JSONRPCErrorException(
          formatFetchProviderError(err),
          GatewayErrors.PROVIDER_ERROR,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new JSONRPCErrorException('Redirect with no Location header', GatewayErrors.PROVIDER_ERROR);
        }

        const redirectUrl = new URL(location, params.url).href;
        const redirectCheck = evaluateUrlPolicy(redirectUrl, urlPolicyConfig);
        if (!redirectCheck.allowed) {
          log.warn(`Redirect URL blocked: ${redirectCheck.reason} (${redirectUrl})`);
          throw new JSONRPCErrorException(`Redirect blocked: ${redirectCheck.reason}`, GatewayErrors.POLICY_DENIED);
        }
        const redirectParsed = new URL(redirectUrl);
        const redirectDns = await checkResolvedIP(redirectParsed.hostname);
        if (!redirectDns.allowed) {
          log.warn(`Redirect DNS blocked: ${redirectDns.reason} (${redirectUrl})`);
          throw new JSONRPCErrorException(`Redirect blocked: ${redirectDns.reason}`, GatewayErrors.POLICY_DENIED);
        }

        let redirectResponse: Response;
        try {
          redirectResponse = await fetch(redirectUrl, {
            headers: { 'User-Agent': WEB_FETCH_USER_AGENT },
            signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
            redirect: 'error',
          });
        } catch (err) {
          throw new JSONRPCErrorException(
            formatFetchProviderError(err),
            GatewayErrors.PROVIDER_ERROR,
          );
        }
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
    summary: (p: WebFetchParams) => ({ url: p.url }),
    approvalAction: 'fetch',
    approvalScope: (p: WebFetchParams) => p.url,
  },
];

export function registerWebMethods(runtime: GatewayMethodRuntime): void {
  const urlPolicyConfig: UrlPolicyConfig = {
    allowHttp: process.env.ALLOW_HTTP_FETCH === 'true',
    domainAllowlist: process.env.FETCH_DOMAIN_ALLOWLIST
      ? process.env.FETCH_DOMAIN_ALLOWLIST.split(',').map(d => d.trim()).filter(Boolean)
      : undefined,
  };
  runtime.policyConfig.urlPolicy = urlPolicyConfig;

  registerGatedDescriptors(runtime, webDescriptors);
}
