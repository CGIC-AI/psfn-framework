import { assertNoUnknownKeys, isRecord } from '../../../../shared/utils/types.js';
import { assertBoundedRulePattern } from './proximity.js';

export interface IntakeEncodingPolicy {
  maxCandidatesPerEncoding: number;
  maxEncodedChars: number;
  maxCipherChars: number;
  unpromptedBase64MinEncodedChars: number;
  unpromptedHexMinEncodedChars: number;
  unpromptedPercentMinGroups: number;
  minTextBytes: number;
  minPrintableRatio: number;
  cueWindowChars: number;
  decodingCue: RegExp;
  injectionProbe: RegExp;
  candidatePatterns: Readonly<{
    base64: RegExp;
    hex: RegExp;
    percent: RegExp;
  }>;
}

function invalid(sourcePath: string, detail: string): Error {
  return new Error(`Invalid intake L1 encoding policy at ${sourcePath}: ${detail}`);
}

function requireInteger(
  value: unknown,
  field: string,
  sourcePath: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(sourcePath, `${field} must be an integer in [${String(minimum)}, ${String(maximum)}]`);
  }
  return value as number;
}

function requireRatio(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(sourcePath, `${field} must be a finite number in [0, 1]`);
  }
  return value;
}

function compilePolicyPattern(
  value: unknown,
  field: string,
  sourcePath: string,
  global: boolean,
): RegExp {
  if (typeof value !== 'string') {
    throw invalid(sourcePath, `${field} must be a string`);
  }
  try {
    assertBoundedRulePattern(value, field);
    const pattern = new RegExp(value, global ? 'giu' : 'iu');
    if (pattern.test('')) {
      throw invalid(sourcePath, `${field} must not match empty text`);
    }
    pattern.lastIndex = 0;
    return pattern;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid intake L1 encoding policy')) {
      throw error;
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw invalid(sourcePath, `${field} is unsafe or invalid: ${cause}`);
  }
}

/** Fail-closed compiler for the encoding policy co-owned by intake-l1-rules.json. */
export function compileIntakeEncodingPolicy(
  raw: unknown,
  sourcePath: string,
): IntakeEncodingPolicy {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'encodingPolicy must be an object');
  }
  assertNoUnknownKeys(raw, [
    'maxCandidatesPerEncoding',
    'maxEncodedChars',
    'maxCipherChars',
    'unpromptedBase64MinEncodedChars',
    'unpromptedHexMinEncodedChars',
    'unpromptedPercentMinGroups',
    'minTextBytes',
    'minPrintableRatio',
    'cueWindowChars',
    'decodingCuePattern',
    'injectionProbePattern',
    'candidatePatterns',
  ], 'encodingPolicy', { errorPrefix: `Invalid intake L1 encoding policy at ${sourcePath}` });
  if (!isRecord(raw.candidatePatterns)) {
    throw invalid(sourcePath, 'encodingPolicy.candidatePatterns must be an object');
  }
  assertNoUnknownKeys(
    raw.candidatePatterns,
    ['base64', 'hex', 'percent'],
    'encodingPolicy.candidatePatterns',
    { errorPrefix: `Invalid intake L1 encoding policy at ${sourcePath}` },
  );

  return {
    maxCandidatesPerEncoding: requireInteger(
      raw.maxCandidatesPerEncoding,
      'encodingPolicy.maxCandidatesPerEncoding',
      sourcePath,
      1,
      32,
    ),
    maxEncodedChars: requireInteger(
      raw.maxEncodedChars,
      'encodingPolicy.maxEncodedChars',
      sourcePath,
      16,
      4_096,
    ),
    maxCipherChars: requireInteger(
      raw.maxCipherChars,
      'encodingPolicy.maxCipherChars',
      sourcePath,
      64,
      32_768,
    ),
    unpromptedBase64MinEncodedChars: requireInteger(
      raw.unpromptedBase64MinEncodedChars,
      'encodingPolicy.unpromptedBase64MinEncodedChars',
      sourcePath,
      16,
      4_096,
    ),
    unpromptedHexMinEncodedChars: requireInteger(
      raw.unpromptedHexMinEncodedChars,
      'encodingPolicy.unpromptedHexMinEncodedChars',
      sourcePath,
      8,
      4_096,
    ),
    unpromptedPercentMinGroups: requireInteger(
      raw.unpromptedPercentMinGroups,
      'encodingPolicy.unpromptedPercentMinGroups',
      sourcePath,
      2,
      1_365,
    ),
    minTextBytes: requireInteger(
      raw.minTextBytes,
      'encodingPolicy.minTextBytes',
      sourcePath,
      1,
      256,
    ),
    minPrintableRatio: requireRatio(
      raw.minPrintableRatio,
      'encodingPolicy.minPrintableRatio',
      sourcePath,
    ),
    cueWindowChars: requireInteger(
      raw.cueWindowChars,
      'encodingPolicy.cueWindowChars',
      sourcePath,
      16,
      512,
    ),
    decodingCue: compilePolicyPattern(
      raw.decodingCuePattern,
      'encodingPolicy.decodingCuePattern',
      sourcePath,
      false,
    ),
    injectionProbe: compilePolicyPattern(
      raw.injectionProbePattern,
      'encodingPolicy.injectionProbePattern',
      sourcePath,
      false,
    ),
    candidatePatterns: {
      base64: compilePolicyPattern(
        raw.candidatePatterns.base64,
        'encodingPolicy.candidatePatterns.base64',
        sourcePath,
        true,
      ),
      hex: compilePolicyPattern(
        raw.candidatePatterns.hex,
        'encodingPolicy.candidatePatterns.hex',
        sourcePath,
        true,
      ),
      percent: compilePolicyPattern(
        raw.candidatePatterns.percent,
        'encodingPolicy.candidatePatterns.percent',
        sourcePath,
        true,
      ),
    },
  };
}
