// ── Encoding-smuggling scanner: base64 / rot13 / hex / percent blobs (htm9.4) ──
//
// Flags encoded payloads that decode to TEXT (smuggled instructions), while
// staying quiet on legitimate binary payloads: base64 image data decodes to
// bytes with a ~0.4 printable-ASCII ratio, smuggled English decodes ≥ 0.9,
// so the textlike threshold separates them cleanly. This is what keeps a
// pasted data:image/png;base64 attachment from lighting up the scanner
// (pinned by the false-positive regression tests).
//
// Candidate bounds, decoding cues, and decoded-content probes are owned by
// intake-l1-rules.json and compiled fail-closed with the rule snapshot.

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';
import { decodeUpsideDownForIntakeSecurityProbe } from './security-normalization.js';
import type { IntakeEncodingPolicy } from './encoding-policy.js';

export const ENCODING_SMUGGLING_SCANNER_ID = 'l1.encoding';

const DATA_IMAGE_PREFIX =
  /data:image\/[a-z0-9.+-]{1,32}(?:;[a-z0-9!#$&^_.+-]{1,32}=[^;,\r\n]{1,128}){0,8};base64,$/i;
const DATA_TEXT_URL = /data:text\/[a-z0-9.+-]{1,32};base64,/i;

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

function decodeBase64Prefix(run: string, maxEncodedChars: number): Buffer {
  const prefix = run.slice(0, maxEncodedChars);
  // Trim to a 4-char boundary so Buffer decodes the full prefix cleanly.
  const aligned = prefix.slice(0, prefix.length - (prefix.length % 4));
  return Buffer.from(aligned, 'base64');
}

function decodeHexPrefix(run: string, maxEncodedChars: number): Buffer {
  const prefix = run.replace(/\s/gu, '').slice(0, maxEncodedChars);
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
  policy: IntakeEncodingPolicy,
): IntakeScannerResult {
  const candidates: IntakeScannerFinding[] = [];
  let base64BlobCount = 0;
  let base64TextlikeCount = 0;
  let base64InjectionHit = false;
  let hexTextlikeCount = 0;
  let percentInjectionHit = false;

  const matchesDecodeCue = (text: string): boolean => {
    policy.decodingCue.lastIndex = 0;
    return policy.decodingCue.test(text);
  };
  const hasDecodeCue = (index: number, encodedLength: number): boolean => {
    const before = normalized.slice(Math.max(0, index - policy.cueWindowChars), index);
    if (matchesDecodeCue(before)) return true;
    const afterStart = index + encodedLength;
    return matchesDecodeCue(normalized.slice(afterStart, afterStart + policy.cueWindowChars));
  };
  const hasInjectionProbe = (decoded: string): boolean => {
    policy.injectionProbe.lastIndex = 0;
    return policy.injectionProbe.test(decoded);
  };

  policy.candidatePatterns.base64.lastIndex = 0;
  for (let examined = 0; examined < policy.maxCandidatesPerEncoding; examined += 1) {
    const match = policy.candidatePatterns.base64.exec(normalized);
    if (match === null) break;
    base64BlobCount += 1;
    // Legit inline image data: data:image/...;base64,<blob> stays quiet.
    const before = normalized.slice(0, match.index);
    if (DATA_IMAGE_PREFIX.test(before)) continue;
    const unprompted = match[0].length >= policy.unpromptedBase64MinEncodedChars;
    if (!unprompted && !hasDecodeCue(match.index, match[0].length)) continue;
    const decoded = decodeBase64Prefix(match[0], policy.maxEncodedChars);
    if (decoded.length < policy.minTextBytes) continue;
    if (printableAsciiRatio(decoded) < policy.minPrintableRatio) continue;
    const injectionHit = hasInjectionProbe(decoded.toString('latin1'));
    if (!unprompted && !injectionHit) continue;
    base64TextlikeCount += 1;
    if (injectionHit) {
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

  policy.candidatePatterns.hex.lastIndex = 0;
  for (let examined = 0; examined < policy.maxCandidatesPerEncoding; examined += 1) {
    const match = policy.candidatePatterns.hex.exec(normalized);
    if (match === null) break;
    const compactLength = match[0].replace(/\s/gu, '').length;
    const unprompted = compactLength >= policy.unpromptedHexMinEncodedChars;
    if (!unprompted && !hasDecodeCue(match.index, match[0].length)) continue;
    const decoded = decodeHexPrefix(match[0], policy.maxEncodedChars);
    if (decoded.length < policy.minTextBytes) continue;
    if (printableAsciiRatio(decoded) < policy.minPrintableRatio) continue;
    if (!unprompted && !hasInjectionProbe(decoded.toString('latin1'))) continue;
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
  if (hasInjectionProbe(rot13(normalized.slice(0, policy.maxCipherChars)))) {
    candidates.push({
      ruleId: 'rot13_smuggling',
      labels: ['injection/encoded_smuggling'],
      weight: 0.8,
      scope: 'all',
      detail: 'rot13-decoded text matches injection-shaped keywords',
    });
  }
  if (hasInjectionProbe(
    decodeUpsideDownForIntakeSecurityProbe(normalized),
  )) {
    candidates.push({
      ruleId: 'upside_down_smuggling',
      labels: ['injection/encoded_smuggling'],
      weight: 0.8,
      scope: 'all',
      detail: 'upside-down text decodes to injection-shaped keywords',
    });
  }

  policy.candidatePatterns.percent.lastIndex = 0;
  for (let examined = 0; examined < policy.maxCandidatesPerEncoding; examined += 1) {
    const match = policy.candidatePatterns.percent.exec(normalized);
    if (match === null) break;
    const groupCount = match[0].length / 3;
    if (groupCount < policy.unpromptedPercentMinGroups
      && !hasDecodeCue(match.index, match[0].length)) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[0]);
    } catch {
      continue; // malformed escape run; not decodable, nothing to probe
    }
    if (hasInjectionProbe(decoded)) {
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
