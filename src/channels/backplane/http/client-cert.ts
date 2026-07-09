// ── Client-certificate identity derivation (Sprint-10 finding C1) ──
//
// Satellite mTLS authentication must never trust request headers by default:
// a certificate fingerprint/subject is public, so header string comparison is
// replayable by any caller. This module is the ONLY sanctioned way to obtain
// a client-cert identity, from exactly two fail-closed sources:
//
// 1. `tls_peer` — the real peer certificate of the terminated TLS socket
//    (`requestCert: true` listener). `subject`/`san` are only exposed when
//    the socket chain-validated the certificate (`authorized === true`),
//    because any self-signed certificate can carry an arbitrary subject.
//    Fingerprint/SPKI hashes are self-authenticating pins and always usable.
// 2. `trusted_proxy` — `X-PSFN-Client-Cert-*` headers asserted by a
//    TLS-terminating proxy that authenticated itself with the configured
//    trusted-proxy token (timing-safe compare). The proxy contract requires
//    the proxy to (a) validate the client certificate chain before
//    forwarding subject/SAN, and (b) strip/overwrite any inbound
//    `X-PSFN-Client-Cert-*` headers from its own clients.
//
// Every PSFN listener must call `stripClientCertHeaders` after derivation so
// unauthenticated cert headers can never leak past the ingress.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { DetailedPeerCertificate, TLSSocket } from 'node:tls';
import type { SatelliteClientCertIdentity } from '../../../shared/contracts/satellite-registry.js';

export const CLIENT_CERT_HEADER_NAMES = {
  fingerprintSha256: 'x-psfn-client-cert-fingerprint-sha256',
  spkiSha256: 'x-psfn-client-cert-spki-sha256',
  subject: 'x-psfn-client-cert-subject',
  san: 'x-psfn-client-cert-san',
} as const;

export const TRUSTED_PROXY_TOKEN_HEADER = 'x-psfn-trusted-proxy-token';

const STRIPPED_HEADER_NAMES = new Set<string>([
  ...Object.values(CLIENT_CERT_HEADER_NAMES),
  TRUSTED_PROXY_TOKEN_HEADER,
]);

const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MIN_TRUSTED_PROXY_TOKEN_LENGTH = 32;

type HeaderMap = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

export interface ClientCertDerivationOptions {
  /**
   * Shared secret a TLS-terminating proxy must present in
   * `X-PSFN-Trusted-Proxy-Token` before its `X-PSFN-Client-Cert-*` headers
   * are honored. When absent, header-asserted certificates are NEVER
   * accepted anywhere.
   */
  trustedProxyToken?: string;
}

/** Minimal request shape so tests can construct fake sockets without live TLS. */
export interface ClientCertRequestLike {
  headers: HeaderMap;
  socket: unknown;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSha256Hex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/:/gu, '');
  return HEX_SHA256_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Deterministic subject rendering for `getPeerCertificate().subject`:
 * `KEY=value` pairs joined with `, ` in certificate order, multi-valued
 * attributes flattened. Registry `clientCertSubject` bindings must use this
 * exact form.
 */
export function formatPeerCertificateSubject(
  subject: Record<string, string | string[]> | undefined,
): string | undefined {
  if (!subject) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(subject)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) parts.push(`${key}=${entry}`);
      }
    } else if (typeof value === 'string' && value.length > 0) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function timingSafeTokenEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

interface PeerCertSocketLike {
  encrypted?: boolean;
  authorized?: boolean;
  getPeerCertificate?: (detailed?: boolean) => DetailedPeerCertificate | object | null;
}

function deriveFromTlsSocket(socket: unknown): SatelliteClientCertIdentity | undefined {
  const candidate = socket as PeerCertSocketLike | null | undefined;
  if (!candidate || candidate.encrypted !== true || typeof candidate.getPeerCertificate !== 'function') {
    return undefined;
  }
  const peer = candidate.getPeerCertificate(true) as Partial<DetailedPeerCertificate> | null;
  if (!peer || typeof peer !== 'object' || Object.keys(peer).length === 0) {
    return undefined;
  }

  const fingerprintSha256 = normalizeSha256Hex(
    typeof peer.fingerprint256 === 'string' ? peer.fingerprint256 : undefined,
  );
  const spkiSha256 = peer.pubkey instanceof Uint8Array && peer.pubkey.length > 0
    ? createHash('sha256').update(peer.pubkey).digest('hex')
    : undefined;
  // Subject/SAN are attacker-choosable on self-signed certificates: only
  // expose them when the TLS layer actually validated the chain.
  const chainAuthorized = (candidate as TLSSocket).authorized === true;
  const subject = chainAuthorized
    ? formatPeerCertificateSubject(peer.subject as Record<string, string | string[]> | undefined)
    : undefined;
  const san = chainAuthorized && typeof peer.subjectaltname === 'string' && peer.subjectaltname.trim().length > 0
    ? peer.subjectaltname.trim()
    : undefined;

  if (!fingerprintSha256 && !spkiSha256 && !subject && !san) {
    return undefined;
  }
  return {
    source: 'tls_peer',
    ...(fingerprintSha256 ? { fingerprintSha256 } : {}),
    ...(spkiSha256 ? { spkiSha256 } : {}),
    ...(subject ? { subject } : {}),
    ...(san ? { san } : {}),
  };
}

function deriveFromTrustedProxy(
  headers: HeaderMap,
  trustedProxyToken: string | undefined,
): SatelliteClientCertIdentity | undefined {
  if (!trustedProxyToken) return undefined;
  const presentedToken = firstHeaderValue(headers[TRUSTED_PROXY_TOKEN_HEADER]);
  if (!presentedToken || !timingSafeTokenEqual(presentedToken, trustedProxyToken)) {
    return undefined;
  }

  const fingerprintSha256 = normalizeSha256Hex(firstHeaderValue(headers[CLIENT_CERT_HEADER_NAMES.fingerprintSha256]));
  const spkiSha256 = normalizeSha256Hex(firstHeaderValue(headers[CLIENT_CERT_HEADER_NAMES.spkiSha256]));
  const subject = firstHeaderValue(headers[CLIENT_CERT_HEADER_NAMES.subject]);
  const san = firstHeaderValue(headers[CLIENT_CERT_HEADER_NAMES.san]);
  if (!fingerprintSha256 && !spkiSha256 && !subject && !san) {
    return undefined;
  }
  return {
    source: 'trusted_proxy',
    ...(fingerprintSha256 ? { fingerprintSha256 } : {}),
    ...(spkiSha256 ? { spkiSha256 } : {}),
    ...(subject ? { subject } : {}),
    ...(san ? { san } : {}),
  };
}

/**
 * Derive the client-certificate identity for a request. Precedence:
 * real TLS peer certificate first, then a token-authenticated trusted proxy.
 * Returns `undefined` when neither authenticated source is available —
 * mTLS-bound satellite endpoints then fail closed.
 */
export function deriveClientCertIdentity(
  request: ClientCertRequestLike,
  options: ClientCertDerivationOptions = {},
): SatelliteClientCertIdentity | undefined {
  const fromSocket = deriveFromTlsSocket(request.socket);
  if (fromSocket) return fromSocket;
  return deriveFromTrustedProxy(request.headers, options.trustedProxyToken);
}

/**
 * Unconditionally remove inbound `X-PSFN-Client-Cert-*` headers and the
 * trusted-proxy token from a header map, in place. Call this at every
 * ingress AFTER `deriveClientCertIdentity` so nothing downstream can read
 * unauthenticated certificate assertions.
 */
export function stripClientCertHeaders(headers: HeaderMap): void {
  for (const name of Object.keys(headers)) {
    if (STRIPPED_HEADER_NAMES.has(name.toLowerCase())) {
      delete headers[name];
    }
  }
}

/**
 * Parse/validate the trusted-proxy token from configuration. A configured
 * token that is too weak to serve as an authentication secret is a startup
 * error (fail closed) rather than a silently accepted downgrade.
 */
export function parseTrustedProxyClientCertToken(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < MIN_TRUSTED_PROXY_TOKEN_LENGTH) {
    throw new Error(
      `API_TRUSTED_PROXY_CLIENT_CERT_TOKEN must be at least ${MIN_TRUSTED_PROXY_TOKEN_LENGTH} characters`,
    );
  }
  return trimmed;
}
