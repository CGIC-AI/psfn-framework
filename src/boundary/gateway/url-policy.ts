// ── URL security policy for gateway web.fetch ──
// Blocks SSRF vectors: private networks, localhost, cloud metadata, HTTP.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { sleep } from '../../shared/utils/timing.js';

// ── Normalized CIDR classification (Sprint-10 H1) ──
// The previous literal-regex classifier missed IPv6 forms the URL parser and
// DNS can normalize past it (`::`, ULA `fc00::/7`, the IPv6 IMDS at
// `fd00:ec2::254`, hex-form mapped addresses, NAT64/6to4/Teredo embeddings).
// ipaddr.js parses the address into its canonical form first, so every
// spelling of the same address classifies identically.
//
// Classification tiers:
// - 'always_blocked': refused in EVERY lane, including allowInternalNetwork
//   (cloud metadata / link-local / unspecified / ULA / IPv4-embedding forms).
// - 'private':        refused by default, reachable only with
//   allowInternalNetwork (RFC1918, loopback, CGNAT, reserved).
// - 'public':         globally routable unicast.
export type IpClassification = 'public' | 'private' | 'always_blocked';

// Deprecated IPv6 site-local (fec0::/10). ipaddr.js 2.2.0 classifies it as
// plain unicast, but it is an internal-only range like ULA — always block.
const IPV6_SITE_LOCAL = ipaddr.parseCIDR('fec0::/10');

function classifyIPv4(address: ipaddr.IPv4): IpClassification {
  switch (address.range()) {
    case 'unicast':
      return 'public';
    case 'unspecified':   // 0.0.0.0/8 "this" network
    case 'linkLocal':     // 169.254.0.0/16 (cloud metadata!)
    case 'broadcast':
    case 'multicast':
      return 'always_blocked';
    default:
      // private (RFC1918), loopback, carrierGradeNat, reserved, as112, ...
      return 'private';
  }
}

function classifyIPv6(address: ipaddr.IPv6): IpClassification {
  if (address.isIPv4MappedAddress()) {
    // Covers dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms alike:
    // classify the embedded IPv4 address.
    return classifyIPv4(address.toIPv4Address());
  }
  if (address.match(IPV6_SITE_LOCAL)) {
    return 'always_blocked';
  }
  switch (address.range()) {
    case 'unicast':
      return 'public';
    case 'loopback':      // ::1 — reachable with allowInternalNetwork
      return 'private';
    default:
      // unspecified (::), linkLocal (fe80::/10), uniqueLocal (fc00::/7 —
      // includes the IPv6 IMDS fd00:ec2::254), multicast, and every
      // IPv4-embedding/transition range (rfc6052 NAT64, rfc6145, 6to4,
      // teredo) plus reserved/benchmarking/orchid2/... — fail closed.
      return 'always_blocked';
  }
}

/** Classify an IP-address string. Unparseable input fails closed. */
export function classifyIpAddress(ip: string): IpClassification {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip);
  } catch {
    return 'always_blocked';
  }
  return parsed.kind() === 'ipv4'
    ? classifyIPv4(parsed as ipaddr.IPv4)
    : classifyIPv6(parsed as ipaddr.IPv6);
}

/** True for any address that is not globally-routable public unicast. */
export function isPrivateIP(ip: string): boolean {
  return classifyIpAddress(ip) !== 'public';
}

/** Check if an IP is in an always-blocked range (cloud metadata, link-local,
 *  unspecified, ULA, IPv4-embedding transition ranges).
 *  These are blocked even when internal network access is allowed. */
export function isAlwaysBlockedIP(ip: string): boolean {
  return classifyIpAddress(ip) === 'always_blocked';
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

// ── Host allowlist entries (Sprint-10 01-M2) ──
// Entries may pin a port: `host`, `host:port`, `[v6literal]`, `[v6literal]:port`.
// A port-pinned entry matches only that exact effective port, so a redirect to
// another port of an allowlisted host (e.g. the Home Assistant host) is
// rejected instead of silently staying "in allowlist".
interface HostAllowlistEntry {
  host: string;
  port?: string;
}

function parseHostAllowlistEntry(raw: string): HostAllowlistEntry | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const bracketWithPort = value.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (bracketWithPort) {
    return { host: bracketWithPort[1], port: String(Number.parseInt(bracketWithPort[2], 10)) };
  }
  const bracketOnly = value.match(/^\[([^\]]+)\]$/);
  if (bracketOnly) {
    return { host: bracketOnly[1] };
  }

  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host, port] = value.split(':');
    if (!host || !/^\d{1,5}$/.test(port)) {
      // Malformed host:port entry. Keep it as a never-matching literal host
      // (hostnames cannot contain ':') so the allowlist stays non-empty and
      // enforcement remains active — dropping it would fail open.
      return { host: value };
    }
    return { host, port: String(Number.parseInt(port, 10)) };
  }

  // Zero colons: plain hostname/IPv4. Multiple colons: bare IPv6 literal.
  return { host: value };
}

function toHostAllowlist(values: readonly string[] | undefined): HostAllowlistEntry[] {
  if (!values || values.length === 0) return [];
  return values
    .map(parseHostAllowlistEntry)
    .filter((entry): entry is HostAllowlistEntry => entry !== null);
}

/** Effective TCP port of a parsed http(s) URL (explicit port or scheme default). */
export function effectiveUrlPort(parsed: URL): string {
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

function matchesHostAllowlist(
  hostname: string,
  parsed: URL,
  entries: readonly HostAllowlistEntry[],
): boolean {
  if (entries.length === 0) return false;
  const port = effectiveUrlPort(parsed);
  return entries.some(entry =>
    entry.host === hostname && (entry.port === undefined || entry.port === port));
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
  const hostAllowlist = toHostAllowlist(isLocalCrawlerLane
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

    const hostAllowed = matchesHostAllowlist(hostname, parsed, hostAllowlist);
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
    const hostAllowed = matchesHostAllowlist(hostname, parsed, hostAllowlist);
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
