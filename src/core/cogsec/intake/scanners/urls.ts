// ── URL extraction + unknown-domain scanner (htm9.4) ──
//
// Extracts http(s) URLs (bounded run, capped count), surfaces them as
// extracted fields for the envelope, and flags exfil-shaped links:
// mixed-script confusable host labels, embedded credentials, and IP-literal
// hosts. Unknown domains are flagged only when the caller provides an
// allowlist (htm9.2 passes it from policy — an empty posture must not turn
// every ordinary link into noise).

import { domainToUnicode } from 'node:url';
import type { IntakeUrlSchemeAction } from '../../../../shared/contracts/intake-url-scanner.js';
import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';
import { normalizeForIntakeSecurityProbe } from './security-normalization.js';

export const URL_SCANNER_ID = 'l1.urls';

const MAX_URLS_EXAMINED = 32;
const MAX_EXTRACTED_URLS_CHARS = 4_096;
const URL_RUN = /https?:\/\/[^\s<>"'`)\]]{1,2048}/gi;
const URI_SCHEME_RUN = /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*):/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]{1,8}$/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const LETTER_OR_MARK_RUN = /[\p{L}\p{M}]+/gu;

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hasMixedScriptConfusableLabel(host: string): boolean {
  const unicodeHost = domainToUnicode(host);
  return unicodeHost.split('.').some((label) => {
    if (!LATIN_SCRIPT.test(label)) return false;
    // Prefix each letter run so the shared projector folds its confusables;
    // the label-level Latin guard above keeps wholly non-Latin labels intact.
    const projected = label.replace(LETTER_OR_MARK_RUN, (run) => (
      normalizeForIntakeSecurityProbe(`a${run}`).slice(1)
    ));
    return projected !== label;
  });
}

export interface UrlScanOptions {
  /**
   * Known-domain allowlist (bare hostnames; subdomains match by suffix).
   * When absent or empty, unknown-domain flagging is disabled — extraction
   * and credential/IP findings still run.
   */
  knownDomains?: readonly string[];
  /** Policy-owned action for each security-relevant URI scheme. */
  schemeActions?: Readonly<Record<string, IntakeUrlSchemeAction>>;
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
  let mixedScriptHostnameCount = 0;
  let deniedSchemeCount = 0;
  let malformedCount = 0;

  URI_SCHEME_RUN.lastIndex = 0;
  while (deniedSchemeCount < MAX_URLS_EXAMINED) {
    const match = URI_SCHEME_RUN.exec(normalized);
    if (match === null) break;
    const scheme = match[2]?.toLowerCase();
    if (!scheme) continue;
    const action = options.schemeActions?.[scheme];
    if (action === undefined || action === 'allow') continue;
    if (action === 'deny_except_inline_image') {
      const afterScheme = normalized.slice(match.index + match[0].length);
      if (/^image\/[a-z0-9.+-]+(?:;|,)/iu.test(afterScheme)) continue;
    }
    deniedSchemeCount += 1;
  }

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
    } else {
      if (hasMixedScriptConfusableLabel(host)) {
        mixedScriptHostnameCount += 1;
      }
      if (knownDomains.length > 0 && !knownDomains.some((domain) => hostMatchesDomain(host, domain))) {
        unknownDomainCount += 1;
      }
    }
  }

  if (deniedSchemeCount > 0) {
    candidates.push({
      ruleId: 'denied_url_scheme',
      labels: ['exfil/unknown_link'],
      weight: 0.8,
      scope: 'all',
      detail: `${String(deniedSchemeCount)} URL(s) using a policy-denied scheme`,
    });
  }

  if (mixedScriptHostnameCount > 0) {
    candidates.push({
      ruleId: 'mixed_script_hostname',
      labels: ['exfil/unknown_link'],
      weight: 0.8,
      scope: 'all',
      detail: `${String(mixedScriptHostnameCount)} URL(s) with a confusable mixed-script host label`,
    });
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
