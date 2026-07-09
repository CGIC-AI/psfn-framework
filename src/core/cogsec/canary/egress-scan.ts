// ── CogSec canary egress scan (htm9.18) ──
//
// The deterministic, near-zero-cost check that runs at the gateway egress
// boundary: does an outbound method's free-text carry this session's planted
// canary? A hit means privileged prompt material has leaked into egress —
// prompt leak / hijack in progress — and the action must be HELD.
//
// Cost contract: benign turns pay one `String.includes` per outbound string.
// The recursive walk over nested params is bounded by depth, node count, and
// total scanned bytes so a hostile or huge payload can never turn the scan into
// a DoS; hitting a bound fails CLOSED (treated as a potential leak → hold).

import { CANARY_CARRIER_PARAM_KEY } from './canary-token.js';

/**
 * Gateway RPC methods whose parameters carry free text bound for the outside
 * world (other humans, external hosts, operator notifications). These are the
 * surfaces a leaked canary would ride out on. LLM/provider calls are excluded:
 * the canary lives in the prompt legitimately, so scanning them would always
 * self-trip.
 */
export const EGRESS_CANARY_METHODS: ReadonlySet<string> = new Set([
  'discord.send',
  'discord.sendMedia',
  'notify.ntfy',
  'web.fetch',
  'web.fetch_binary',
  'web.request_binary',
  'web.search',
  'companion.message.send',
]);

export function isEgressCanaryMethod(method: string): boolean {
  return EGRESS_CANARY_METHODS.has(method);
}

/** Bounds on the recursive param walk. Exceeding any bound fails closed. */
const MAX_DEPTH = 8;
const MAX_NODES = 4096;
const MAX_SCANNED_BYTES = 4 * 1024 * 1024; // 4 MiB of string content

export type CanaryScanResult =
  | { leaked: false }
  | { leaked: true; reason: 'token_present' | 'scan_bound_exceeded' | 'scan_error' };

/**
 * Scan an outbound params object for the given canary token. Returns
 * `{ leaked: true }` on a substring hit OR on any fail-closed condition (bound
 * exceeded, unexpected error). The reserved carrier key is never traversed —
 * the token always rides there, so scanning it would be a guaranteed self-hit.
 */
export function scanEgressParamsForCanary(params: unknown, token: string): CanaryScanResult {
  if (!token) return { leaked: false };
  let nodes = 0;
  let scannedBytes = 0;

  const walk = (value: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) throw new RangeError('scan_bound_exceeded');
    nodes += 1;
    if (nodes > MAX_NODES) throw new RangeError('scan_bound_exceeded');

    if (typeof value === 'string') {
      scannedBytes += value.length;
      if (scannedBytes > MAX_SCANNED_BYTES) throw new RangeError('scan_bound_exceeded');
      return value.includes(token);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (walk(item, depth + 1)) return true;
      }
      return false;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // Never scan the carrier field: the token lives there by construction.
        if (depth === 0 && key === CANARY_CARRIER_PARAM_KEY) continue;
        if (walk(child, depth + 1)) return true;
      }
      return false;
    }
    return false;
  };

  try {
    return walk(params, 0) ? { leaked: true, reason: 'token_present' } : { leaked: false };
  } catch (error) {
    if (error instanceof RangeError && error.message === 'scan_bound_exceeded') {
      return { leaked: true, reason: 'scan_bound_exceeded' };
    }
    return { leaked: true, reason: 'scan_error' };
  }
}

/**
 * Return a shallow clone of `params` with the reserved canary carrier key
 * removed, so the real method handler and every audit/log path only ever see
 * the cleartext-free params. Non-object params pass through unchanged.
 */
export function stripCanaryCarrier(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  if (!(CANARY_CARRIER_PARAM_KEY in (params as Record<string, unknown>))) return params;
  const clone = { ...(params as Record<string, unknown>) };
  delete clone[CANARY_CARRIER_PARAM_KEY];
  return clone;
}

/** Read the carrier token from an egress params object, if present. */
export function readCanaryCarrier(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
