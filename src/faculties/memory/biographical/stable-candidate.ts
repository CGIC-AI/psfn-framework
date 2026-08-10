import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import { BiographicalClaimValidationError } from './claim-kinds.js';
import { prepareBiographicalClaim } from './store-port.js';
import type { BiographicalClaimWriteInput } from './store-port.js';
import type { BiographicalClaimKind } from './types.js';

const PORTABLE_STABLE_KINDS: readonly BiographicalClaimKind[] = [
  'role',
  'stable-preference',
  'shared-language',
];

/**
 * Strict extraction boundary for portable stable-biography candidates. Model
 * output cannot choose lifecycle status, attach free-form notes, define a new
 * kind/schema, or smuggle extra human subjects through unknown fields. The
 * shared kernel performs the canonical value, subject, temporal, sensitivity,
 * source and depth validation before the candidate may reach admission.
 */
export function parsePortableStableCandidate(
  value: unknown,
  options: { readonly now?: Date } = {},
): BiographicalClaimWriteInput {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['subject', 'kind', 'value', 'basis', 'confidence', 'sources'],
      [
        'relatedSubject',
        'proposedSensitivity',
        'validFrom',
        'validTo',
        'depthDecision',
      ],
    )
  ) {
    throw new BiographicalClaimValidationError(
      'portable stable candidate has unknown or missing fields; status and free-form notes are forbidden',
    );
  }
  if (
    typeof value.kind !== 'string'
    || !(PORTABLE_STABLE_KINDS as readonly string[]).includes(value.kind)
  ) {
    throw new BiographicalClaimValidationError(
      `portable stable candidate kind must be one of: ${PORTABLE_STABLE_KINDS.join(', ')}`,
    );
  }

  const prepared = prepareBiographicalClaim({
    subject: value.subject as BiographicalClaimWriteInput['subject'],
    ...(value.relatedSubject !== undefined
      ? { relatedSubject: value.relatedSubject as BiographicalClaimWriteInput['relatedSubject'] }
      : {}),
    kind: value.kind as BiographicalClaimKind,
    value: value.value as BiographicalClaimWriteInput['value'],
    basis: value.basis as BiographicalClaimWriteInput['basis'],
    ...(value.proposedSensitivity !== undefined
      ? {
          proposedSensitivity:
            value.proposedSensitivity as BiographicalClaimWriteInput['proposedSensitivity'],
        }
      : {}),
    confidence: value.confidence as number,
    sources: value.sources as BiographicalClaimWriteInput['sources'],
    ...(value.validFrom !== undefined ? { validFrom: value.validFrom as string } : {}),
    ...(value.validTo !== undefined ? { validTo: value.validTo as string } : {}),
    ...(value.depthDecision !== undefined
      ? { depthDecision: value.depthDecision as BiographicalClaimWriteInput['depthDecision'] }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    subject: prepared.subject,
    ...(prepared.relatedSubject !== undefined
      ? { relatedSubject: prepared.relatedSubject }
      : {}),
    kind: prepared.kind,
    value: prepared.value,
    basis: prepared.basis,
    proposedSensitivity: prepared.proposedSensitivity,
    confidence: prepared.confidence,
    sources: prepared.sources,
    ...(prepared.validFrom !== undefined ? { validFrom: prepared.validFrom } : {}),
    ...(prepared.validTo !== undefined ? { validTo: prepared.validTo } : {}),
    ...(prepared.depthDecision !== undefined
      ? { depthDecision: prepared.depthDecision }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
}
