// Bounded deterministic decode-then-probe scanner. Mutable limits and probe
// patterns come from the L1 owner file; this module owns only orchestration.

import { gunzipSync } from 'node:zlib';
import {
  decodeAscii85,
  decodeAtbash,
  decodeBase32,
  decodeBase58,
  decodeUtf7,
  rotateAscii,
} from './encoding-decoders.js';
import {
  encodingCipherProbeAttemptCount,
  INTAKE_ENCODING_CANDIDATE_IDS,
  type IntakeEncodingCandidateId,
  type IntakeEncodingPolicy,
} from './encoding-policy.js';
import { decodeUpsideDownForIntakeSecurityProbe } from './security-normalization.js';
import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const ENCODING_SMUGGLING_SCANNER_ID = 'l1.encoding';

const DATA_IMAGE_PREFIX =
  /data:image\/[a-z0-9.+-]{1,32}(?:;[a-z0-9!#$&^_.+-]{1,32}=[^;,\r\n]{1,128}){0,8};base64,$/iu;
const DATA_TEXT_URL = /data:text\/[a-z0-9.+-]{1,32};base64,/iu;
const GZIP_CANDIDATE_GROUP = 'gzipBase64';

type CandidateAttemptGroup = IntakeEncodingCandidateId | typeof GZIP_CANDIDATE_GROUP;

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

function patternMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function decodedText(bytes: Uint8Array, policy: IntakeEncodingPolicy): string | null {
  if (bytes.length < policy.minTextBytes) return null;
  if (printableAsciiRatio(bytes) < policy.minPrintableRatio) return null;
  return Buffer.from(bytes).toString('utf8').slice(0, policy.maxDecodedChars);
}

/** Runs on capped, security-normalized probe text. */
export function scanEncodingSmuggling(
  normalized: string,
  scope: IntakeScanScope,
  policy: IntakeEncodingPolicy,
): IntakeScannerResult {
  const candidates: IntakeScannerFinding[] = [];
  const emitted = new Set<string>();
  const groupAttempts = new Map<CandidateAttemptGroup, number>();
  let attempts = 0;
  let base64BlobCount = 0;

  const candidateGroupCount = INTAKE_ENCODING_CANDIDATE_IDS.length + 1;
  const candidateAttemptBudget = Math.max(
    0,
    policy.maxTotalDecodeAttempts - encodingCipherProbeAttemptCount(policy.maxCaesarShifts),
  );
  const perCandidateGroupBudget = Math.min(
    policy.maxCandidatesPerEncoding,
    Math.floor(candidateAttemptBudget / candidateGroupCount),
  );

  const consumeAttempt = (): boolean => {
    if (attempts >= policy.maxTotalDecodeAttempts) return false;
    attempts += 1;
    return true;
  };
  const consumeCandidateAttempt = (group: CandidateAttemptGroup): boolean => {
    const used = groupAttempts.get(group) ?? 0;
    if (used >= perCandidateGroupBudget || !consumeAttempt()) return false;
    groupAttempts.set(group, used + 1);
    return true;
  };
  const hasCue = (index: number, encodedLength: number): boolean => {
    const before = normalized.slice(Math.max(0, index - policy.cueWindowChars), index);
    if (patternMatches(policy.decodingCue, before)) return true;
    const afterStart = index + encodedLength;
    return patternMatches(
      policy.decodingCue,
      normalized.slice(afterStart, afterStart + policy.cueWindowChars),
    );
  };
  const hasProbe = (text: string): boolean => patternMatches(policy.injectionProbe, text);
  const add = (
    ruleId: string,
    detail: string,
    weight = 0.8,
    includeOverride = false,
  ): void => {
    if (emitted.has(ruleId)) return;
    emitted.add(ruleId);
    candidates.push({
      ruleId,
      labels: includeOverride
        ? ['injection/encoded_smuggling', 'injection/override_attempt']
        : ['injection/encoded_smuggling'],
      weight,
      scope: 'all',
      detail,
    });
  };
  const matches = function* (id: IntakeEncodingCandidateId): Generator<RegExpExecArray> {
    const pattern = policy.candidatePatterns[id];
    pattern.lastIndex = 0;
    for (let examined = 0; examined < policy.maxCandidatesPerEncoding; examined += 1) {
      const match = pattern.exec(normalized);
      if (match === null) return;
      yield match;
      if (match[0].length === 0) return;
    }
  };
  const probeDecoded = (
    bytes: Uint8Array,
    match: RegExpExecArray,
  ): { text: string; injection: boolean } | null => {
    const text = decodedText(bytes.subarray(0, policy.maxDecodedChars), policy);
    if (text === null) return null;
    const suffixStart = match.index + match[0].length;
    const suffix = normalized.slice(suffixStart, suffixStart + policy.cueWindowChars);
    return { text, injection: hasProbe(`${text}${suffix}`) };
  };

  const cipherInput = normalized.slice(0, policy.maxCipherChars);
  for (let shift = 1; shift <= policy.maxCaesarShifts; shift += 1) {
    if (!consumeAttempt()) break;
    if (!hasProbe(rotateAscii(cipherInput, shift))) continue;
    if (shift === 13) {
      add('rot13_smuggling', 'rot13-decoded text matches injection-shaped keywords');
    } else {
      add('caesar_shift_payload', 'Caesar-shifted text decodes to injection-shaped keywords');
    }
  }
  if (consumeAttempt() && hasProbe(decodeAtbash(cipherInput))) {
    add('atbash_payload', 'Atbash text decodes to injection-shaped keywords');
  }
  if (consumeAttempt() && hasProbe([...cipherInput].reverse().join(''))) {
    add('reversed_payload', 'reversed text decodes to injection-shaped keywords');
  }
  // Preserve the current full capped-input behavior: long benign prefixes must
  // not hide an upside-down payload beyond the cipher transform span.
  if (consumeAttempt() && hasProbe(decodeUpsideDownForIntakeSecurityProbe(normalized))) {
    add('upside_down_smuggling', 'upside-down text decodes to injection-shaped keywords');
  }

  for (const match of matches('base64')) {
    base64BlobCount += 1;
    const before = normalized.slice(0, match.index);
    if (DATA_IMAGE_PREFIX.test(before)) continue;
    const unprompted = match[0].length >= policy.unpromptedBase64MinEncodedChars;
    if (!unprompted && !hasCue(match.index, match[0].length)) continue;
    if (!consumeCandidateAttempt('base64')) break;
    const encoded = match[0].slice(0, policy.maxEncodedChars);
    const remainder = encoded.length % 4;
    if (remainder === 1) continue;
    const padded = remainder === 0 ? encoded : encoded.padEnd(encoded.length + 4 - remainder, '=');
    const bytes = Buffer.from(padded, 'base64');
    const result = probeDecoded(bytes, match);
    if (result && (unprompted || result.injection)) {
      add('base64_text_blob', 'base64 payload decodes to suspicious printable text', 0.7);
      if (result.injection) {
        add('base64_injection_payload', 'base64 payload decodes to injection-shaped text', 0.9, true);
      }
    }
    if (bytes[0] !== 0x1F || bytes[1] !== 0x8B
      || !consumeCandidateAttempt(GZIP_CANDIDATE_GROUP)) continue;
    const ratioBound = Math.max(1, Math.floor(bytes.length * policy.maxInflationRatio));
    const maxOutputLength = Math.min(policy.maxInflatedBytes, ratioBound);
    try {
      const inflated = gunzipSync(bytes, { maxOutputLength });
      if (probeDecoded(inflated, match)?.injection) {
        add('gzip_base64_payload', 'gzip+base64 payload inflates to injection-shaped text', 0.9);
      }
    } catch {
      add(
        'gzip_base64_rejected',
        'gzip+base64 payload is invalid or exceeds an inflation bound',
        0.9,
      );
    }
  }

  if (DATA_TEXT_URL.test(normalized)) {
    add('data_text_url', 'data:text/*;base64 URL present', 0.6);
  }

  for (const match of matches('hex')) {
    const compact = match[0].replace(/\s/gu, '');
    const unprompted = compact.length >= policy.unpromptedHexMinEncodedChars;
    if (!unprompted && !hasCue(match.index, match[0].length)) continue;
    if (!consumeCandidateAttempt('hex')) break;
    const bytes = Buffer.from(compact.slice(0, policy.maxEncodedChars), 'hex');
    const result = probeDecoded(bytes, match);
    if (result && (unprompted || result.injection)) {
      add('hex_text_blob', 'hex payload decodes to suspicious printable text', 0.6);
    }
  }

  const byteDecoders: ReadonlyArray<{
    id: Exclude<IntakeEncodingCandidateId, 'base64' | 'hex' | 'numericCodepoints'>;
    ruleId: string;
    decode(value: string): Buffer | null;
    cueRequired?: boolean;
  }> = [
    {
      id: 'percent', ruleId: 'percent_encoded_payload',
      decode: value => {
        try {
          return Buffer.from(decodeURIComponent(value), 'utf8');
        } catch {
          return null;
        }
      },
    },
    {
      id: 'backslashHex', ruleId: 'backslash_hex_payload',
      decode: value => Buffer.from(value.replace(/\\x/gu, ''), 'hex'),
    },
    {
      id: 'htmlNumeric', ruleId: 'numeric_character_reference_payload',
      decode: value => {
        const text = value.replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (_match, digits: string) => {
          const radix = digits[0]!.toLowerCase() === 'x' ? 16 : 10;
          const rawDigits = radix === 16 ? digits.slice(1) : digits;
          const codePoint = Number.parseInt(rawDigits, radix);
          return Number.isSafeInteger(codePoint) && codePoint <= 0x10FFFF
            ? String.fromCodePoint(codePoint)
            : '\uFFFD';
        });
        return Buffer.from(text, 'utf8');
      },
    },
    {
      id: 'jsonUnicode', ruleId: 'json_unicode_escape_payload',
      decode: value => Buffer.from(value.replace(
        /\\u([0-9a-f]{4})/giu,
        (_match, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)),
      ), 'utf8'),
    },
    {
      id: 'binaryBytes', ruleId: 'binary_byte_payload', cueRequired: true,
      decode: value => Buffer.from(value.trim().split(/\s+/u).map(byte => Number.parseInt(byte, 2))),
    },
    { id: 'utf7', ruleId: 'utf7_payload', decode: decodeUtf7, cueRequired: true },
    { id: 'base32', ruleId: 'base32_payload', decode: decodeBase32, cueRequired: true },
    { id: 'base58', ruleId: 'base58_payload', decode: decodeBase58, cueRequired: true },
    { id: 'base85', ruleId: 'base85_payload', decode: decodeAscii85, cueRequired: true },
  ];

  for (const decoder of byteDecoders) {
    for (const match of matches(decoder.id)) {
      if (decoder.id === 'percent') {
        const groupCount = match[0].length / 3;
        if (groupCount < policy.unpromptedPercentMinGroups
          && !hasCue(match.index, match[0].length)) continue;
      } else if (decoder.cueRequired && !hasCue(match.index, match[0].length)) {
        continue;
      }
      if (!consumeCandidateAttempt(decoder.id)) break;
      const bytes = decoder.decode(match[0].slice(0, policy.maxEncodedChars));
      if (bytes && probeDecoded(bytes, match)?.injection) {
        add(decoder.ruleId, `${decoder.id} payload decodes to injection-shaped text`);
      }
    }
  }

  for (const match of matches('numericCodepoints')) {
    if (!hasCue(match.index, match[0].length)) continue;
    const values = match[0].trim().split(/\s+/u);
    for (const radix of [10, 8]) {
      if (!consumeCandidateAttempt('numericCodepoints')) break;
      const numbers = values.map(value => Number.parseInt(value, radix));
      if (numbers.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0x10FFFF)) {
        continue;
      }
      const bytes = Buffer.from(numbers.map(value => String.fromCodePoint(value)).join(''), 'utf8');
      if (probeDecoded(bytes, match)?.injection) {
        add('numeric_codepoint_payload', 'decimal/octal codepoints decode to injection-shaped text');
        break;
      }
    }
  }

  const findings = candidates.filter(finding => scanScopeIncludes(scope, finding.scope));
  return buildScannerResult({
    scannerId: ENCODING_SMUGGLING_SCANNER_ID,
    findings,
    extracted: {
      decode_attempts: String(attempts),
      ...(base64BlobCount > 0 ? { base64_blobs: String(base64BlobCount) } : {}),
    },
  });
}
