// ── SSRF-guarded remote fetch for channel media/attachments ──
//
// Extracted from the Discord-only helper (Sprint-10 6ny2) so every channel
// adapter (Discord, Telegram, ...) downloads remote attachment bytes through
// the same gateway URL policy / SSRF guard instead of bare `fetch(url)`:
//
// - `evaluateUrlPolicy` in the strict default lane (HTTPS only, private hosts
//   blocked) unless the caller explicitly relaxes it (tests only),
// - `checkResolvedIP` on every answer at every hop so mixed/private/metadata
//   DNS snapshots are refused, and an address-pinned transport prevents rebinding,
// - manual redirect handling with per-hop re-validation,
// - a hard timeout via AbortController,
// - a byte cap enforced WHILE streaming the body (never trusts content-length).

import { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { errors, fetch as undiciFetch, type Response } from 'undici';
import { createPinnedAddressAgent } from '../../boundary/gateway/pinned-address-agent.js';
import {
  checkResolvedIP,
  evaluateUrlPolicy,
  type UrlPolicyConfig,
} from '../../boundary/gateway/url-policy.js';

export const REMOTE_FETCH_TIMEOUT_MS = 30_000;
const REMOTE_FETCH_ENCODING_OVERHEAD_BYTES = 64 * 1024;
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface RemoteFetchOptions {
  /** Hard response-body cap in bytes, enforced during streaming. */
  maxBytes: number;
  timeoutMs?: number;
  /** URL policy override. Production callers omit this (strict default lane). */
  urlPolicy?: UrlPolicyConfig;
  /** DNS resolver override for tests; a single answer remains supported. */
  dnsResolver?: (hostname: string) => Promise<LookupAddress | LookupAddress[]>;
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
  dnsResolver: RemoteFetchOptions['dnsResolver'],
): Promise<string> {
  const decision = evaluateUrlPolicy(url, policy, 'default');
  if (!decision.allowed) {
    throw new Error(`Remote fetch blocked: ${decision.reason}`);
  }
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new Error('Remote fetch blocked: URL credentials are not allowed');
  }
  const dnsPolicy = {
    allowPrivateResolvedIp: policy.allowInternalNetwork === true,
  };
  let answers: LookupAddress[] = [];
  const resolved = await checkResolvedIP(parsed.hostname, async hostname => {
    const result = await (dnsResolver ? dnsResolver(hostname) : lookup(hostname, { all: true }));
    answers = Array.isArray(result) ? result : [result];
    const first = answers[0];
    if (!first) throw new Error('DNS yielded no usable address');
    return first;
  }, dnsPolicy);
  if (!resolved.allowed || !resolved.address) {
    throw new Error(`Remote fetch blocked: ${resolved.reason}`);
  }
  // Authorize the complete DNS snapshot, then connect only to its first answer.
  // Checking outside the resolver prevents a policy denial becoming a DNS retry.
  for (const answer of answers) {
    if ((answer.family !== 4 && answer.family !== 6) || isIP(answer.address) !== answer.family) {
      throw new Error('Remote fetch blocked: DNS address family mismatch');
    }
    const decision = await checkResolvedIP(answer.address, undefined, dnsPolicy);
    if (!decision.allowed) throw new Error(`Remote fetch blocked: ${decision.reason}`);
  }
  return resolved.address;
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

async function validateBeforeAbort(
  url: string,
  policy: UrlPolicyConfig,
  dnsResolver: RemoteFetchOptions['dnsResolver'],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([validateRemoteUrl(url, policy, dnsResolver), aborted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
  // Bound encoded input separately: framing/metadata may exceed a tiny decoded
  // cap. Large bodies get at most twice that cap; small ones get 64 KiB slack.
  const maxWireBytes = options.maxBytes + Math.max(options.maxBytes, REMOTE_FETCH_ENCODING_OVERHEAD_BYTES);

  const abort = new AbortController();
  const state = { timedOut: false };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    abort.abort();
  }, timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; ; hop += 1) {
      const address = await validateBeforeAbort(currentUrl, policy, options.dnsResolver, abort.signal);
      const dispatcher = createPinnedAddressAgent({
        address,
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs,
        maxResponseBytes: maxWireBytes,
        maxOrigins: 1,
        connections: 1,
      });

      try {
        const response = await undiciFetch(currentUrl, {
          // This API carries no caller headers, cookies, or redirect credentials.
          redirect: 'manual',
          signal: abort.signal,
          dispatcher,
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
      } finally {
        await dispatcher.destroy();
      }
    }
  } catch (error) {
    if (state.timedOut) {
      throw new Error(`Remote fetch timed out after ${timeoutMs}ms`);
    }
    if (error instanceof Error && error.cause instanceof errors.ResponseExceededMaxSizeError) {
      throw new Error(`Remote fetch body too large: exceeded ${options.maxBytes} bytes`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
