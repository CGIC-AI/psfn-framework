import type { UrlPolicyConfig } from '../../boundary/gateway/url-policy.js';
import { fetchRemoteResource } from '../../channels/backplane/safe-remote-fetch.js';
import { WEB_FETCH_TIMEOUT_MS } from '../../system/security/policy-constants.js';
import type { ImageRuntimeConfig } from './types.js';

const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface RemoteImageBinary {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

function normalizeContentType(value: string | null | undefined): string {
  return ((value ?? '').split(';')[0] ?? '').trim().toLowerCase();
}

function resolveUrlPolicyConfig(config: ImageRuntimeConfig): UrlPolicyConfig {
  return {
    allowHttp: config.webFetchAllowHttp === true,
    domainAllowlist: config.webFetchDomainAllowlist,
    allowInternalNetwork: config.webFetchAllowInternalNetwork === true,
  };
}

async function fetchValidatedBinary(
  url: string,
  config: ImageRuntimeConfig,
  fetchImpl: typeof fetch,
): Promise<RemoteImageBinary> {
  const response = await fetchRemoteResource(url, {
    maxBytes: DEFAULT_REMOTE_IMAGE_MAX_BYTES,
    timeoutMs: WEB_FETCH_TIMEOUT_MS,
    urlPolicy: resolveUrlPolicyConfig(config),
    dnsResolver: config.webFetchDnsResolver,
    fetchImpl,
  });
  if (!response.ok) {
    throw new Error(`Failed to download image input (${response.status})`);
  }
  const contentType = normalizeContentType(response.contentType);
  if (!contentType.startsWith('image/')) {
    throw new Error(`Remote image fetch returned non-image content type ${contentType || 'unknown'}`);
  }
  return {
    bytes: response.bytes,
    contentType,
    finalUrl: response.finalUrl,
  };
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
    const encoded = match[3] ?? '';
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
