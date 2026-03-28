import { evaluateUrlPolicy, checkResolvedIP, resolveMaxRedirectHops, type UrlPolicyConfig } from '../gateway/url-policy.js';
import { WEB_FETCH_TIMEOUT_MS, WEB_FETCH_USER_AGENT } from '../system/security/policy-constants.js';
import type { ImageRuntimeConfig } from './types.js';

const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface RemoteImageBinary {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

function normalizeContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function resolveUrlPolicyConfig(config: ImageRuntimeConfig): UrlPolicyConfig {
  return {
    allowHttp: config.webFetchAllowHttp === true,
    domainAllowlist: config.webFetchDomainAllowlist,
    allowInternalNetwork: config.webFetchAllowInternalNetwork === true,
  };
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).toString();
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${WEB_FETCH_TIMEOUT_MS}ms`)), WEB_FETCH_TIMEOUT_MS);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchValidatedBinary(
  url: string,
  config: ImageRuntimeConfig,
  fetchImpl: typeof fetch,
): Promise<RemoteImageBinary> {
  const urlPolicyConfig = resolveUrlPolicyConfig(config);
  const dnsResolver = config.webFetchDnsResolver;
  const maxRedirectHops = resolveMaxRedirectHops(urlPolicyConfig);
  const visited = new Set<string>();
  let currentUrl = url;
  let hopCount = 0;

  for (;;) {
    const urlCheck = evaluateUrlPolicy(currentUrl, urlPolicyConfig);
    if (!urlCheck.allowed) {
      throw new Error(`URL blocked: ${urlCheck.reason}`);
    }

    const parsed = new URL(currentUrl);
    const dnsCheck = await checkResolvedIP(parsed.hostname, dnsResolver, {
      allowPrivateResolvedIp: config.webFetchAllowInternalNetwork === true,
    });
    if (!dnsCheck.allowed) {
      throw new Error(`URL blocked: ${dnsCheck.reason}`);
    }

    const response = await fetchWithTimeout(fetchImpl, currentUrl, {
      method: 'GET',
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': WEB_FETCH_USER_AGENT,
      },
      redirect: 'manual',
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Remote image fetch returned a redirect without a Location header');
      }
      if (hopCount >= maxRedirectHops) {
        throw new Error(`Remote image fetch exceeded ${maxRedirectHops} redirect hops`);
      }

      const nextUrl = resolveRedirectUrl(currentUrl, location);
      if (visited.has(nextUrl)) {
        throw new Error(`Remote image fetch redirect loop detected at ${nextUrl}`);
      }

      visited.add(currentUrl);
      currentUrl = nextUrl;
      hopCount += 1;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to download image input (${response.status} ${response.statusText})`);
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!contentType.startsWith('image/')) {
      throw new Error(`Remote image fetch returned non-image content type ${contentType || 'unknown'}`);
    }

    const reportedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(reportedLength) && reportedLength > DEFAULT_REMOTE_IMAGE_MAX_BYTES) {
      throw new Error(
        `Remote image fetch exceeded ${DEFAULT_REMOTE_IMAGE_MAX_BYTES} bytes (${reportedLength} reported)`,
      );
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length > DEFAULT_REMOTE_IMAGE_MAX_BYTES) {
      throw new Error(`Remote image fetch exceeded ${DEFAULT_REMOTE_IMAGE_MAX_BYTES} bytes (${body.length} actual)`);
    }

    return {
      bytes: body,
      contentType,
      finalUrl: currentUrl,
    };
  }
}

export async function fetchRemoteImageBinary(
  url: string,
  config: ImageRuntimeConfig,
  fetchImpl: typeof fetch,
): Promise<RemoteImageBinary> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) {
      throw new Error('Unsupported data URL image payload');
    }

    const contentType = normalizeContentType(match[1] || 'image/png');
    const encoded = match[3];
    const bytes = match[2]
      ? Uint8Array.from(Buffer.from(encoded, 'base64'))
      : Uint8Array.from(Buffer.from(decodeURIComponent(encoded), 'utf8'));
    if (bytes.length > DEFAULT_REMOTE_IMAGE_MAX_BYTES) {
      throw new Error(`Remote image fetch exceeded ${DEFAULT_REMOTE_IMAGE_MAX_BYTES} bytes (${bytes.length} actual)`);
    }
    return {
      bytes,
      contentType: contentType || 'application/octet-stream',
      finalUrl: url,
    };
  }

  return await fetchValidatedBinary(url, config, fetchImpl);
}
