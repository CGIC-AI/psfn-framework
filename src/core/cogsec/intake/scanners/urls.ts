// ── URL extraction + unknown-domain scanner (htm9.4) ──
//
// Extracts http(s) URLs (bounded run, capped count), surfaces them as
// extracted fields for the envelope, and flags exfil-shaped links:
// embedded credentials and IP-literal hosts always; unknown domains only
// when the caller provides an allowlist (htm9.2 passes it from policy — an
// empty posture must not turn every ordinary link into noise).

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const URL_SCANNER_ID = 'l1.urls';

const MAX_URLS_EXAMINED = 32;
const MAX_EXTRACTED_URLS_CHARS = 4_096;
const URL_RUN = /https?:\/\/[^\s<>"'`)\]]{1,2048}/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]{1,8}$/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export interface UrlScanOptions {
  /**
   * Known-domain allowlist (bare hostnames; subdomains match by suffix).
   * When absent or empty, unknown-domain flagging is disabled — extraction
   * and credential/IP findings still run.
   */
  knownDomains?: readonly string[];
}

/** Runs on the NFKC-normalized, capped text. */
export function scanUrls(
  normalized: string,
  scope: IntakeScanScope,
  options: UrlScanOptions = {},
): IntakeScannerResult {
  const knownDomains = (options.knownDomains ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);

  const urls: string[] = [];
  const candidates: IntakeScannerFinding[] = [];
  let credentialCount = 0;
  let ipLiteralCount = 0;
  let unknownDomainCount = 0;
  let malformedCount = 0;

  URL_RUN.lastIndex = 0;
  for (let examined = 0; examined < MAX_URLS_EXAMINED; examined += 1) {
    const match = URL_RUN.exec(normalized);
    if (match === null) break;
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      malformedCount += 1;
      continue;
    }
    urls.push(candidate);
    if (parsed.username !== '') {
      credentialCount += 1;
    }
    const host = parsed.hostname.toLowerCase();
    if (IPV4_HOST.test(host) || host.startsWith('[')) {
      ipLiteralCount += 1;
    } else if (knownDomains.length > 0 && !knownDomains.some((domain) => hostMatchesDomain(host, domain))) {
      unknownDomainCount += 1;
    }
  }

  if (credentialCount > 0) {
    candidates.push({
      ruleId: 'url_embedded_credentials',
      labels: ['exfil/unknown_link', 'pii/credential_adjacent'],
      weight: 0.8,
      scope: 'all',
      detail: `${String(credentialCount)} URL(s) with embedded credentials`,
    });
  }
  if (ipLiteralCount > 0) {
    candidates.push({
      ruleId: 'ip_literal_url',
      labels: ['exfil/unknown_link'],
      weight: 0.5,
      scope: 'context',
      detail: `${String(ipLiteralCount)} URL(s) with IP-literal host`,
    });
  }
  if (unknownDomainCount > 0) {
    candidates.push({
      ruleId: 'unknown_domain',
      labels: ['exfil/unknown_link'],
      weight: 0.3,
      scope: 'context',
      detail: `${String(unknownDomainCount)} URL(s) outside the known-domain allowlist`,
    });
  }

  const findings = candidates.filter((finding) => scanScopeIncludes(scope, finding.scope));
  const result: {
    scannerId: string;
    findings: IntakeScannerFinding[];
    extracted?: Record<string, string>;
  } = { scannerId: URL_SCANNER_ID, findings };
  if (urls.length > 0 || malformedCount > 0) {
    const extracted: Record<string, string> = { url_count: String(urls.length) };
    if (urls.length > 0) {
      extracted.urls = urls.join('\n').slice(0, MAX_EXTRACTED_URLS_CHARS);
    }
    if (malformedCount > 0) {
      extracted.malformed_urls = String(malformedCount);
    }
    result.extracted = extracted;
  }
  return buildScannerResult(result);
}
