// ── URL security policy for gateway web.fetch ──
// Blocks SSRF vectors: private networks, localhost, cloud metadata, HTTP.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { sleep } from '../../shared/utils/timing.js';

const PRIVATE_RANGES = [
  // IPv4
  /^127\./,                          // loopback
  /^10\./,                           // RFC1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC1918 Class B
  /^192\.168\./,                     // RFC1918 Class C
  /^169\.254\./,                     // link-local (cloud metadata!)
  /^0\./,                            // "this" network
  // IPv6
  /^::1$/,                           // loopback
  /^fe80:/i,                         // link-local
  /^fc00:/i,                         // unique local
  /^fd/i,                            // unique local
];

/** Always-blocked ranges even when allowInternalNetwork is true.
 *  These are dangerous (cloud metadata, link-local, "this" network). */
const ALWAYS_BLOCKED_RANGES = [
  /^169\.254\./,                     // link-local / cloud metadata
  /^0\./,                            // "this" network
  /^fe80:/i,                         // IPv6 link-local
];

function decodeIPv4MappedIPv6(ip: string): string | null {
  const dottedMapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMapped) {
    return dottedMapped[1];
  }

  const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexMapped) {
    return null;
  }

  const upper = Number.parseInt(hexMapped[1], 16);
  const lower = Number.parseInt(hexMapped[2], 16);
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) {
    return null;
  }

  return [
    (upper >>> 8) & 0xff,
    upper & 0xff,
    (lower >>> 8) & 0xff,
    lower & 0xff,
  ].join('.');
}

export function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mapped4 = decodeIPv4MappedIPv6(ip);
  if (mapped4) return isPrivateIP(mapped4);
  if (/^::ffff:/i.test(ip)) return true; // hex-form mapped addresses (::ffff:7f00:1) — block conservatively

  return PRIVATE_RANGES.some(r => r.test(ip));
}

/** Check if an IP is in an always-blocked range (cloud metadata, link-local).
 *  These are blocked even when internal network access is allowed. */
export function isAlwaysBlockedIP(ip: string): boolean {
  const mapped4 = decodeIPv4MappedIPv6(ip);
  if (mapped4) return isAlwaysBlockedIP(mapped4);
  if (/^::ffff:/i.test(ip)) return true; // conservatively block unknown mapped form

  return ALWAYS_BLOCKED_RANGES.some(r => r.test(ip));
}

export type UrlPolicyLane = 'default' | 'local_crawler' | 'discovery' | 'home_assistant';
export const DEFAULT_MAX_REDIRECT_HOPS = 5;
export const MAX_REDIRECT_HOPS = 20;

export interface UrlPolicyConfig {
  allowHttp?: boolean;           // default false (require HTTPS)
  domainAllowlist?: string[];    // if set, only these domains allowed
  hostAllowlist?: string[];      // if set, only these exact hosts allowed
  allowInternalNetwork?: boolean; // allow RFC1918/loopback access (still blocks cloud metadata)
  maxRedirectHops?: number;      // default 5, bounded to [0, 20]
  /** @deprecated Use allowInternalNetwork + domainAllowlist instead */
  localCrawlerLane?: {
    enabled?: boolean;
    allowHttp?: boolean;
    domainAllowlist?: string[];
    hostAllowlist?: string[];
  };
  discoveryLane?: {
    enabled?: boolean;
    allowHttp?: boolean;
    urlAllowlist?: string[];
  };
}

export interface UrlPolicyResult {
  allowed: boolean;
  reason?: string;
}

export interface ResolvedIPPolicyResult extends UrlPolicyResult {
  address?: string;
}

export function resolveMaxRedirectHops(config: UrlPolicyConfig = {}): number {
  const rawValue = config.maxRedirectHops;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    return DEFAULT_MAX_REDIRECT_HOPS;
  }

  const normalized = Math.floor(rawValue);
  if (normalized < 0) {
    return 0;
  }
  return Math.min(normalized, MAX_REDIRECT_HOPS);
}

function toLowerList(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeAbsoluteHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if ((parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function toNormalizedUrlAllowlist(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const normalized = values
    .map(value => normalizeAbsoluteHttpUrl(value.trim()))
    .filter((value): value is string => Boolean(value));
  return [...new Set(normalized)];
}

function matchesDomainAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowlist.some(domain => lower === domain || lower.endsWith('.' + domain));
}

function normalizeHostname(parsed: URL): string {
  const rawHostname = parsed.hostname;
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  return hostname.toLowerCase();
}

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === 'localhost.localdomain' || hostname.endsWith('.localhost');
}

export function evaluateUrlPolicy(
  urlString: string,
  config: UrlPolicyConfig = {},
  lane: UrlPolicyLane = 'default',
): UrlPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  const isLocalCrawlerLane = lane === 'local_crawler';
  const isDiscoveryLane = lane === 'discovery';
  const localCrawler = config.localCrawlerLane;
  if (isLocalCrawlerLane && localCrawler?.enabled !== true) {
    return { allowed: false, reason: 'Local crawler lane is not enabled' };
  }
  const discoveryLane = config.discoveryLane;
  if (isDiscoveryLane && discoveryLane?.enabled !== true) {
    return { allowed: false, reason: 'Discovery lane is not enabled' };
  }

  if (isDiscoveryLane) {
    const allowHttp = discoveryLane?.allowHttp === true;
    if (parsed.protocol === 'http:' && !allowHttp) {
      return { allowed: false, reason: 'HTTP not allowed (use HTTPS)' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `Protocol ${parsed.protocol} not allowed` };
    }

    const discoveryUrlAllowlist = toNormalizedUrlAllowlist(discoveryLane?.urlAllowlist);
    if (discoveryUrlAllowlist.length === 0) {
      return { allowed: false, reason: 'Discovery lane requires URL allowlist' };
    }

    const normalizedTarget = normalizeAbsoluteHttpUrl(parsed.toString());
    if (!normalizedTarget || !discoveryUrlAllowlist.includes(normalizedTarget)) {
      return { allowed: false, reason: `URL ${parsed.toString()} not allowlisted for discovery lane` };
    }

    const hostname = normalizeHostname(parsed);
    if (isIP(hostname) && isAlwaysBlockedIP(hostname)) {
      return { allowed: false, reason: `IP ${hostname} blocked (cloud metadata / link-local)` };
    }
    return { allowed: true };
  }

  const allowHttp = isLocalCrawlerLane
    ? localCrawler?.allowHttp === true
    : config.allowHttp === true;
  const domainAllowlist = toLowerList(isLocalCrawlerLane
    ? localCrawler?.domainAllowlist
    : config.domainAllowlist);
  const hostAllowlist = toLowerList(isLocalCrawlerLane
    ? localCrawler?.hostAllowlist
    : config.hostAllowlist);

  // Protocol check
  if (parsed.protocol === 'http:' && !allowHttp) {
    return { allowed: false, reason: 'HTTP not allowed (use HTTPS)' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Protocol ${parsed.protocol} not allowed` };
  }

  const hostname = normalizeHostname(parsed);

  if (isLocalCrawlerLane) {
    if (domainAllowlist.length === 0 && hostAllowlist.length === 0) {
      return { allowed: false, reason: 'Local crawler lane requires host or domain allowlist' };
    }

    const hostAllowed = hostAllowlist.includes(hostname);
    const domainAllowed = matchesDomainAllowlist(hostname, domainAllowlist);
    if (!hostAllowed && !domainAllowed) {
      return { allowed: false, reason: `Host ${hostname} not allowlisted for local crawler lane` };
    }

    // Always block cloud metadata/link-local targets regardless of lane flags.
    if (isIP(hostname) && isAlwaysBlockedIP(hostname)) {
      return { allowed: false, reason: `IP ${hostname} blocked (cloud metadata / link-local)` };
    }

    // Local crawler lane is explicit opt-in. Do not apply the strict private-host default checks.
    return { allowed: true };
  }

  // Host/domain allowlists
  if (hostAllowlist.length > 0 || domainAllowlist.length > 0) {
    const hostAllowed = hostAllowlist.includes(hostname);
    const domainAllowed = matchesDomainAllowlist(hostname, domainAllowlist);
    if (!hostAllowed && !domainAllowed) {
      if (hostAllowlist.length > 0 && domainAllowlist.length === 0) {
        return { allowed: false, reason: `Host ${hostname} not in allowlist` };
      }
      if (hostAllowlist.length === 0) {
        return { allowed: false, reason: `Domain ${hostname} not in allowlist` };
      }
      return { allowed: false, reason: `Host ${hostname} not in host/domain allowlist` };
    }
  }

  // Internal network access mode: allow private IPs and localhost except always-blocked ranges
  if (config.allowInternalNetwork === true) {
    // Always block cloud metadata and link-local even in internal mode
    if (isIP(hostname) && isAlwaysBlockedIP(hostname)) {
      return { allowed: false, reason: `IP ${hostname} blocked (cloud metadata / link-local)` };
    }
    // Private IPs and localhost are allowed in internal mode
    return { allowed: true };
  }

  // Check if hostname is a raw IP
  if (isIP(hostname) && isPrivateIP(hostname)) {
    return { allowed: false, reason: `Private IP ${hostname} blocked` };
  }

  // Check for localhost variants
  if (isLocalhostHost(hostname)) {
    return { allowed: false, reason: 'localhost blocked' };
  }

  return { allowed: true };
}

/** DNS resolver function signature (injectable for testing) */
export type DnsResolver = (hostname: string) => Promise<{ address: string; family: number }>;

/**
 * Post-DNS-resolution check: resolve hostname and verify the IP is not private.
 * Call this AFTER evaluateUrlPolicy passes, for non-raw-IP hostnames.
 * Catches DNS rebinding attacks (e.g. evil.com → 127.0.0.1).
 */
export async function checkResolvedIP(
  hostname: string,
  resolver: DnsResolver | undefined = lookup,
  options: { allowPrivateResolvedIp?: boolean } = {},
): Promise<ResolvedIPPolicyResult> {
  // Strip IPv6 brackets if present (URL parser adds them)
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Evaluate raw IPs too for defense in depth.
  if (isIP(bare)) {
    if (isAlwaysBlockedIP(bare)) {
      return { allowed: false, reason: `IP ${bare} blocked (cloud metadata / link-local)` };
    }
    if (isPrivateIP(bare) && !options.allowPrivateResolvedIp) {
      return { allowed: false, reason: `Private IP ${bare} blocked` };
    }
    return { allowed: true, address: bare };
  }

  let result: { address: string; family: number };
  try {
    result = await resolveWithTransientRetry(bare, resolver);
  } catch {
    return { allowed: false, reason: `DNS resolution failed for ${bare}` };
  }

  if (isAlwaysBlockedIP(result.address)) {
    return {
      allowed: false,
      reason: `DNS resolved ${bare} to blocked IP ${result.address} (cloud metadata / link-local)`,
    };
  }
  if (isPrivateIP(result.address) && !options.allowPrivateResolvedIp) {
    return { allowed: false, reason: `DNS resolved ${bare} to private IP ${result.address}` };
  }
  return { allowed: true, address: result.address };
}

const DNS_RESOLUTION_ATTEMPTS = 2;
const DNS_RESOLUTION_RETRY_DELAY_MS = 250;

// A single transient resolver failure (flaky upstream nameserver) must not
// permanently block an otherwise-allowed fetch; the check still fails closed
// after the final attempt.
async function resolveWithTransientRetry(
  hostname: string,
  resolver: DnsResolver,
): Promise<{ address: string; family: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DNS_RESOLUTION_ATTEMPTS; attempt += 1) {
    try {
      return await resolver(hostname);
    } catch (error) {
      lastError = error;
      if (attempt < DNS_RESOLUTION_ATTEMPTS) {
        await sleep(DNS_RESOLUTION_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}
