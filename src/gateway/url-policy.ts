// ── URL security policy for gateway web.fetch ──
// Blocks SSRF vectors: private networks, localhost, cloud metadata, HTTP.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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

export function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mapped4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped4) return isPrivateIP(mapped4[1]);
  if (/^::ffff:/i.test(ip)) return true; // hex-form mapped addresses (::ffff:7f00:1) — block conservatively

  return PRIVATE_RANGES.some(r => r.test(ip));
}

export type UrlPolicyLane = 'default' | 'local_crawler';

export interface UrlPolicyConfig {
  allowHttp?: boolean;           // default false (require HTTPS)
  domainAllowlist?: string[];    // if set, only these domains allowed
  localCrawlerLane?: {
    enabled?: boolean;
    allowHttp?: boolean;
    domainAllowlist?: string[];
    hostAllowlist?: string[];
  };
}

export interface UrlPolicyResult {
  allowed: boolean;
  reason?: string;
}

function toLowerList(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
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
  const localCrawler = config.localCrawlerLane;
  if (isLocalCrawlerLane && localCrawler?.enabled !== true) {
    return { allowed: false, reason: 'Local crawler lane is not enabled' };
  }

  const allowHttp = isLocalCrawlerLane
    ? localCrawler?.allowHttp === true
    : config.allowHttp === true;
  const domainAllowlist = toLowerList(isLocalCrawlerLane
    ? localCrawler?.domainAllowlist
    : config.domainAllowlist);
  const hostAllowlist = toLowerList(isLocalCrawlerLane
    ? localCrawler?.hostAllowlist
    : undefined);

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

    // Local crawler lane is explicit opt-in. Do not apply the strict private-host default checks.
    return { allowed: true };
  }

  // Domain allowlist
  if (domainAllowlist.length > 0 && !matchesDomainAllowlist(hostname, domainAllowlist)) {
    return { allowed: false, reason: `Domain ${hostname} not in allowlist` };
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
  resolver: DnsResolver = lookup,
  options: { allowPrivateResolvedIp?: boolean } = {},
): Promise<UrlPolicyResult> {
  // Strip IPv6 brackets if present (URL parser adds them)
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Skip for raw IPs — already checked by evaluateUrlPolicy
  if (isIP(bare)) {
    return { allowed: true };
  }

  try {
    const result = await resolver(bare);
    if (isPrivateIP(result.address) && !options.allowPrivateResolvedIp) {
      return { allowed: false, reason: `DNS resolved ${bare} to private IP ${result.address}` };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: `DNS resolution failed for ${bare}` };
  }
}
