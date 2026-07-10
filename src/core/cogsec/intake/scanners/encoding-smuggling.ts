// ── Encoding-smuggling scanner: base64 / rot13 / hex / percent blobs (htm9.4) ──
//
// Flags encoded payloads that decode to TEXT (smuggled instructions), while
// staying quiet on legitimate binary payloads: base64 image data decodes to
// bytes with a ~0.4 printable-ASCII ratio, smuggled English decodes ≥ 0.9,
// so the textlike threshold separates them cleanly. This is what keeps a
// pasted data:image/png;base64 attachment from lighting up the scanner
// (pinned by the false-positive regression tests).
//
// All patterns here are engine-internal single-character-class runs
// (`[A-Za-z0-9+/]{80,}` etc.) — unbounded repetition of ONE class is
// linear-time and safe; the rule-file lint only forbids unbounded quantifiers
// in attacker-authorable rule patterns. Input is capped before this runs.

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const ENCODING_SMUGGLING_SCANNER_ID = 'l1.encoding';

const MAX_BLOBS_EXAMINED = 8;
const DECODE_PREFIX_CHARS = 512;
const TEXTLIKE_MIN_BYTES = 24;
const TEXTLIKE_PRINTABLE_RATIO = 0.9;
const ROT13_PROBE_CHARS = 16_384;

const BASE64_RUN = /[A-Za-z0-9+/]{80,}={0,2}/g;
const DATA_IMAGE_PREFIX = /data:image\/[a-z0-9.+-]{1,32};base64,$/i;
const DATA_TEXT_URL = /data:text\/[a-z0-9.+-]{1,32};base64,/i;
const HEX_RUN = /[0-9A-Fa-f]{120,}/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2}){24,}/g;

/**
 * High-signal probe applied to DECODED candidate text. Bounded fillers only
 * (see proximity.ts for the ReDoS rationale).
 */
const DECODED_INJECTION_PROBE =
  /\b(?:ignore|disregard|forget|override)\s{1,8}(?:\w{1,32}\s{1,8}){0,8}(?:instructions|rules|directives)\b|\bsystem\s{1,8}prompt\b|\bapi[_-]?key\b|\bpassword\s{0,4}[:=]/i;

function printableAsciiRatio(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let printable = 0;
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0A || byte === 0x0D || (byte >= 0x20 && byte <= 0x7E)) {
      printable += 1;
    }
  }
  return printable / bytes.length;
}

function decodeBase64Prefix(run: string): Buffer {
  const prefix = run.slice(0, DECODE_PREFIX_CHARS);
  // Trim to a 4-char boundary so Buffer decodes the full prefix cleanly.
  const aligned = prefix.slice(0, prefix.length - (prefix.length % 4));
  return Buffer.from(aligned, 'base64');
}

function decodeHexPrefix(run: string): Buffer {
  const prefix = run.slice(0, DECODE_PREFIX_CHARS);
  const aligned = prefix.slice(0, prefix.length - (prefix.length % 2));
  return Buffer.from(aligned, 'hex');
}

function rot13(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(((code - 65 + 13) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      out += String.fromCharCode(((code - 97 + 13) % 26) + 97);
    } else {
      out += text[index];
    }
  }
  return out;
}

/** Runs on the NFKC-normalized, capped text. */
export function scanEncodingSmuggling(
  normalized: string,
  scope: IntakeScanScope,
): IntakeScannerResult {
  const candidates: IntakeScannerFinding[] = [];
  let base64BlobCount = 0;
  let base64TextlikeCount = 0;
  let base64InjectionHit = false;
  let hexTextlikeCount = 0;
  let percentInjectionHit = false;

  BASE64_RUN.lastIndex = 0;
  for (let examined = 0; examined < MAX_BLOBS_EXAMINED; examined += 1) {
    const match = BASE64_RUN.exec(normalized);
    if (match === null) break;
    base64BlobCount += 1;
    // Legit inline image data: data:image/...;base64,<blob> stays quiet.
    const before = normalized.slice(Math.max(0, match.index - 48), match.index);
    if (DATA_IMAGE_PREFIX.test(before)) continue;
    const decoded = decodeBase64Prefix(match[0]);
    if (decoded.length < TEXTLIKE_MIN_BYTES) continue;
    if (printableAsciiRatio(decoded) < TEXTLIKE_PRINTABLE_RATIO) continue;
    base64TextlikeCount += 1;
    if (DECODED_INJECTION_PROBE.test(decoded.toString('latin1'))) {
      base64InjectionHit = true;
    }
  }
  if (base64TextlikeCount > 0) {
    candidates.push({
      ruleId: 'base64_text_blob',
      labels: ['injection/encoded_smuggling'],
      weight: 0.7,
      scope: 'all',
      detail: `${String(base64TextlikeCount)} base64 blob(s) decoding to printable text`,
    });
  }
  if (base64InjectionHit) {
    candidates.push({
      ruleId: 'base64_injection_payload',
      labels: ['injection/encoded_smuggling', 'injection/override_attempt'],
      weight: 0.9,
      scope: 'all',
      detail: 'base64 blob decodes to injection-shaped text',
    });
  }

  if (DATA_TEXT_URL.test(normalized)) {
    candidates.push({
      ruleId: 'data_text_url',
      labels: ['injection/encoded_smuggling'],
      weight: 0.6,
      scope: 'all',
      detail: 'data:text/*;base64 URL present',
    });
  }

  HEX_RUN.lastIndex = 0;
  for (let examined = 0; examined < MAX_BLOBS_EXAMINED; examined += 1) {
    const match = HEX_RUN.exec(normalized);
    if (match === null) break;
    const decoded = decodeHexPrefix(match[0]);
    if (decoded.length < TEXTLIKE_MIN_BYTES) continue;
    if (printableAsciiRatio(decoded) < TEXTLIKE_PRINTABLE_RATIO) continue;
    hexTextlikeCount += 1;
  }
  if (hexTextlikeCount > 0) {
    candidates.push({
      ruleId: 'hex_text_blob',
      labels: ['injection/encoded_smuggling'],
      weight: 0.6,
      scope: 'all',
      detail: `${String(hexTextlikeCount)} hex blob(s) decoding to printable text`,
    });
  }

  // rot13: decoding legitimate prose yields gibberish, so a keyword hit on
  // the decoded text is near-zero false positive.
  if (DECODED_INJECTION_PROBE.test(rot13(normalized.slice(0, ROT13_PROBE_CHARS)))) {
    candidates.push({
      ruleId: 'rot13_smuggling',
      labels: ['injection/encoded_smuggling'],
      weight: 0.8,
      scope: 'all',
      detail: 'rot13-decoded text matches injection-shaped keywords',
    });
  }

  PERCENT_RUN.lastIndex = 0;
  for (let examined = 0; examined < MAX_BLOBS_EXAMINED; examined += 1) {
    const match = PERCENT_RUN.exec(normalized);
    if (match === null) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[0]);
    } catch {
      continue; // malformed escape run; not decodable, nothing to probe
    }
    if (DECODED_INJECTION_PROBE.test(decoded)) {
      percentInjectionHit = true;
      break;
    }
  }
  if (percentInjectionHit) {
    candidates.push({
      ruleId: 'percent_encoded_payload',
      labels: ['injection/encoded_smuggling'],
      weight: 0.7,
      scope: 'all',
      detail: 'percent-encoded run decodes to injection-shaped text',
    });
  }

  const findings = candidates.filter((finding) => scanScopeIncludes(scope, finding.scope));
  const result: {
    scannerId: string;
    findings: IntakeScannerFinding[];
    extracted?: Record<string, string>;
  } = { scannerId: ENCODING_SMUGGLING_SCANNER_ID, findings };
  if (base64BlobCount > 0) {
    result.extracted = { base64_blobs: String(base64BlobCount) };
  }
  return buildScannerResult(result);
}
