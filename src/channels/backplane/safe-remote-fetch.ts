// ── SSRF-guarded remote fetch for channel media/attachments ──
//
// Extracted from the Discord-only helper (Sprint-10 6ny2) so every channel
// adapter (Discord, Telegram, ...) downloads remote attachment bytes through
// the same gateway URL policy / SSRF guard instead of bare `fetch(url)`:
//
// - `evaluateUrlPolicy` in the strict default lane (HTTPS only, private hosts
//   blocked) unless the caller explicitly relaxes it (tests only),
// - `checkResolvedIP` on every hop so hostnames resolving to private/metadata
//   addresses are refused,
// - manual redirect handling with per-hop re-validation,
// - a hard timeout via AbortController,
// - a byte cap enforced WHILE streaming the body (never trusts content-length).

import {
  checkResolvedIP,
  evaluateUrlPolicy,
  type DnsResolver,
  type UrlPolicyConfig,
} from '../../boundary/gateway/url-policy.js';

export const REMOTE_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface RemoteFetchOptions {
  /** Hard response-body cap in bytes, enforced during streaming. */
  maxBytes: number;
  timeoutMs?: number;
  /** URL policy override. Production callers omit this (strict default lane). */
  urlPolicy?: UrlPolicyConfig;
  /** DNS resolver override for tests. */
  dnsResolver?: DnsResolver;
}

export interface RemoteFetchResult {
  ok: boolean;
  status: number;
  /** Response body; empty when `ok` is false (error bodies are discarded). */
  bytes: Buffer;
  contentType: string | null;
}

async function validateRemoteUrl(
  url: string,
  policy: UrlPolicyConfig,
  dnsResolver: DnsResolver | undefined,
): Promise<void> {
  const decision = evaluateUrlPolicy(url, policy, 'default');
  if (!decision.allowed) {
    throw new Error(`Remote fetch blocked: ${decision.reason}`);
  }
  const parsed = new URL(url);
  const resolved = await checkResolvedIP(parsed.hostname, dnsResolver, {
    allowPrivateResolvedIp: policy.allowInternalNetwork === true,
  });
  if (!resolved.allowed) {
    throw new Error(`Remote fetch blocked: ${resolved.reason}`);
  }
}

async function readBodyWithCap(
  response: Response,
  maxBytes: number,
  abort: AbortController,
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        abort.abort();
        throw new Error(`Remote fetch body too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a remote HTTP(S) resource with SSRF policy checks, redirect
 * re-validation, a hard timeout, and a streaming byte cap.
 *
 * Throws on policy denial, timeout, redirect abuse, or cap overflow.
 * Non-2xx terminal responses return `{ ok: false, status }` with an empty
 * body so callers keep their own status-specific error messages.
 */
export async function fetchRemoteResource(
  url: string,
  options: RemoteFetchOptions,
): Promise<RemoteFetchResult> {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('Remote fetch requires a positive maxBytes cap');
  }
  const timeoutMs = options.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  const policy = options.urlPolicy ?? {};

  const abort = new AbortController();
  const state = { timedOut: false };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    abort.abort();
  }, timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; ; hop += 1) {
      await validateRemoteUrl(currentUrl, policy, options.dnsResolver);

      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: abort.signal,
      });

      const location = response.headers.get('location');
      if (REDIRECT_STATUS_CODES.has(response.status) && location) {
        await response.body?.cancel();
        if (hop >= MAX_REDIRECT_HOPS) {
          throw new Error(`Remote fetch exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, currentUrl).href;
        } catch {
          throw new Error(`Remote fetch received invalid redirect location: ${location}`);
        }
        currentUrl = redirectUrl;
        continue;
      }

      const contentType = response.headers.get('content-type');
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, bytes: Buffer.alloc(0), contentType };
      }

      const bytes = await readBodyWithCap(response, options.maxBytes, abort);
      return { ok: true, status: response.status, bytes, contentType };
    }
  } catch (error) {
    if (state.timedOut) {
      throw new Error(`Remote fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
