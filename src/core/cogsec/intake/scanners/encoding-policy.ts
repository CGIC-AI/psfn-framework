import { assertNoUnknownKeys, isRecord } from '../../../../shared/utils/types.js';
import { assertBoundedRulePattern } from './proximity.js';

export const INTAKE_ENCODING_CANDIDATE_IDS = [
  'base64',
  'hex',
  'percent',
  'backslashHex',
  'htmlNumeric',
  'jsonUnicode',
  'binaryBytes',
  'numericCodepoints',
  'utf7',
  'base32',
  'base58',
  'base85',
] as const;

export type IntakeEncodingCandidateId = typeof INTAKE_ENCODING_CANDIDATE_IDS[number];

const FIXED_CIPHER_PROBE_IDS = new Set(['atbash', 'reverse', 'upsideDown']);

export function encodingCipherProbeAttemptCount(maxCaesarShifts: number): number {
  return maxCaesarShifts + FIXED_CIPHER_PROBE_IDS.size;
}

export interface IntakeEncodingPolicy {
  maxCandidatesPerEncoding: number;
  maxTotalDecodeAttempts: number;
  maxEncodedChars: number;
  maxDecodedChars: number;
  maxInflatedBytes: number;
  maxInflationRatio: number;
  maxCipherChars: number;
  maxCaesarShifts: number;
  unpromptedBase64MinEncodedChars: number;
  unpromptedHexMinEncodedChars: number;
  unpromptedPercentMinGroups: number;
  minTextBytes: number;
  minPrintableRatio: number;
  cueWindowChars: number;
  decodingCue: RegExp;
  injectionProbe: RegExp;
  candidatePatterns: Readonly<Record<IntakeEncodingCandidateId, RegExp>>;
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

function requirePositiveRatio(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1_024) {
    throw invalid(sourcePath, `${field} must be a finite number in [1, 1024]`);
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
    'maxTotalDecodeAttempts',
    'maxEncodedChars',
    'maxDecodedChars',
    'maxInflatedBytes',
    'maxInflationRatio',
    'maxCipherChars',
    'maxCaesarShifts',
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
    INTAKE_ENCODING_CANDIDATE_IDS,
    'encodingPolicy.candidatePatterns',
    { errorPrefix: `Invalid intake L1 encoding policy at ${sourcePath}` },
  );

  const candidatePatterns = {} as Record<IntakeEncodingCandidateId, RegExp>;
  for (const id of INTAKE_ENCODING_CANDIDATE_IDS) {
    candidatePatterns[id] = compilePolicyPattern(
      raw.candidatePatterns[id],
      `encodingPolicy.candidatePatterns.${id}`,
      sourcePath,
      true,
    );
  }

  const policy: IntakeEncodingPolicy = {
    maxCandidatesPerEncoding: requireInteger(
      raw.maxCandidatesPerEncoding,
      'encodingPolicy.maxCandidatesPerEncoding',
      sourcePath,
      1,
      32,
    ),
    maxTotalDecodeAttempts: requireInteger(
      raw.maxTotalDecodeAttempts,
      'encodingPolicy.maxTotalDecodeAttempts',
      sourcePath,
      1,
      256,
    ),
    maxEncodedChars: requireInteger(
      raw.maxEncodedChars,
      'encodingPolicy.maxEncodedChars',
      sourcePath,
      16,
      8_192,
    ),
    maxDecodedChars: requireInteger(
      raw.maxDecodedChars,
      'encodingPolicy.maxDecodedChars',
      sourcePath,
      16,
      8_192,
    ),
    maxInflatedBytes: requireInteger(
      raw.maxInflatedBytes,
      'encodingPolicy.maxInflatedBytes',
      sourcePath,
      64,
      65_536,
    ),
    maxInflationRatio: requirePositiveRatio(
      raw.maxInflationRatio,
      'encodingPolicy.maxInflationRatio',
      sourcePath,
    ),
    maxCipherChars: requireInteger(
      raw.maxCipherChars,
      'encodingPolicy.maxCipherChars',
      sourcePath,
      64,
      32_768,
    ),
    maxCaesarShifts: requireInteger(
      raw.maxCaesarShifts,
      'encodingPolicy.maxCaesarShifts',
      sourcePath,
      1,
      25,
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
    candidatePatterns,
  };
  const minimumAttempts = encodingCipherProbeAttemptCount(policy.maxCaesarShifts)
    + INTAKE_ENCODING_CANDIDATE_IDS.length
    + 1;
  if (policy.maxTotalDecodeAttempts < minimumAttempts) {
    throw invalid(
      sourcePath,
      `encodingPolicy.maxTotalDecodeAttempts must be at least ${String(minimumAttempts)} `
      + 'to reserve one attempt for every decoder class',
    );
  }
  return policy;
}
