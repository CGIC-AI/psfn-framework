import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  BiographicalClaimKind,
  BiographicalClaimValue,
  BiographicalSubjectRef,
  NameClaimValue,
  NicknameClaimValue,
  RelationshipClaimValue,
} from './types.js';

/**
 * Typed validation failure for biographical claim candidates. Callers can
 * distinguish a malformed candidate (rejected) from an operational/store error.
 */
export class BiographicalClaimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiographicalClaimValidationError';
  }
}

/**
 * Closed registry of biographical claim kinds. Adding a kind is a reviewed
 * schema change; each registered kind owns its structured-value validator,
 * canonicalizer, related-subject rule, kind sensitivity floor, and conflict
 * key. Unknown kinds reject (see {@link assertKnownClaimKind}).
 */

const MAX_NAME_LENGTH = 256;
const MAX_NICKNAME_LENGTH = 256;
const MAX_RELATIONSHIP_TYPE_LENGTH = 128;

interface ClaimKindDefinition {
  readonly kind: BiographicalClaimKind;
  /** Minimum sensitivity any claim of this kind may carry. */
  readonly floorSensitivity: SensitivityLevel;
  /** Whether the kind requires a related subject. */
  readonly requiresRelatedSubject: boolean;
}

const NAME_FLOOR: SensitivityLevel = 'personal';
const NICKNAME_FLOOR: SensitivityLevel = 'personal';
const RELATIONSHIP_FLOOR: SensitivityLevel = 'personal';

const CLAIM_KIND_DEFINITIONS: Readonly<Record<BiographicalClaimKind, ClaimKindDefinition>> = {
  name: {
    kind: 'name',
    floorSensitivity: NAME_FLOOR,
    requiresRelatedSubject: false,
  },
  nickname: {
    kind: 'nickname',
    floorSensitivity: NICKNAME_FLOOR,
    requiresRelatedSubject: false,
  },
  relationship: {
    kind: 'relationship',
    floorSensitivity: RELATIONSHIP_FLOOR,
    requiresRelatedSubject: true,
  },
};

export function assertKnownClaimKind(kind: unknown): asserts kind is BiographicalClaimKind {
  if (
    kind !== 'name'
    && kind !== 'nickname'
    && kind !== 'relationship'
  ) {
    throw new BiographicalClaimValidationError(`Unknown biographical claim kind: ${String(kind)}`);
  }
}

export function claimKindFloor(kind: BiographicalClaimKind): SensitivityLevel {
  return CLAIM_KIND_DEFINITIONS[kind].floorSensitivity;
}

function assertNonEmptyBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== 'string') {
    throw new BiographicalClaimValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BiographicalClaimValidationError(`${field} must be non-empty`);
  }
  if (trimmed.length > maximum) {
    throw new BiographicalClaimValidationError(`${field} must be at most ${maximum} characters`);
  }
  return trimmed;
}

function assertNameValue(value: unknown): NameClaimValue {
  if (!isRecord(value) || value.kind !== 'name') {
    throw new BiographicalClaimValidationError('name claim value must be an object with kind "name"');
  }
  const name = assertNonEmptyBoundedString(value.name, 'name', MAX_NAME_LENGTH);
  const role = value.role;
  if (role !== 'primary' && role !== 'alias') {
    throw new BiographicalClaimValidationError('name role must be one of: primary, alias');
  }
  return { kind: 'name', name, role };
}

function assertNicknameValue(value: unknown): NicknameClaimValue {
  if (!isRecord(value) || value.kind !== 'nickname') {
    throw new BiographicalClaimValidationError('nickname claim value must be an object with kind "nickname"');
  }
  const nickname = assertNonEmptyBoundedString(value.nickname, 'nickname', MAX_NICKNAME_LENGTH);
  const scope = value.scope;
  if (scope !== 'self' && scope !== 'relational') {
    throw new BiographicalClaimValidationError('nickname scope must be one of: self, relational');
  }
  return { kind: 'nickname', nickname, scope };
}

function assertRelationshipValue(value: unknown): RelationshipClaimValue {
  if (!isRecord(value) || value.kind !== 'relationship') {
    throw new BiographicalClaimValidationError('relationship claim value must be an object with kind "relationship"');
  }
  const relationshipType = assertNonEmptyBoundedString(
    value.relationshipType,
    'relationshipType',
    MAX_RELATIONSHIP_TYPE_LENGTH,
  );
  return { kind: 'relationship', relationshipType };
}

/**
 * Validate and canonicalize a structured value for `kind`. Canonicalization is
 * currently trim-only (the stored value is verbatim after validation); the
 * {@link BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION} pins this so any change to
 * normalization intentionally invalidates claim digests.
 */
export function canonicalizeClaimValue(
  kind: BiographicalClaimKind,
  value: unknown,
): BiographicalClaimValue {
  if (kind === 'name') return assertNameValue(value);
  if (kind === 'nickname') return assertNicknameValue(value);
  return assertRelationshipValue(value);
}

/** Case-insensitive normalized token used for coalescing and conflict keys. */
function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable identity string for a subject reference, used inside conflict keys
 * and digests so the same canonical subject always hashes identically.
 */
function subjectRefIdentity(subject: BiographicalSubjectRef): string {
  return subject.kind === 'companion'
    ? `companion:${subject.companionId}:${subject.subjectVersion}`
    : `contact:${subject.contactId}:${subject.subjectVersion}`;
}

/**
 * Conflict key for a claim. Two claims with the same key cannot both be active:
 * the deterministic conflict rule marks the key contested (or supersedes).
 * Different keys coexist. Kind-specific; no inferred exclusivity.
 *
 * - `name`: subject + role. Two primaries conflict; aliases coexist.
 * - `nickname`: subject + normalized nickname + scope. Same nickname/scope
 *   coalesce; different nicknames coexist.
 * - `relationship`: subject + related subject + normalized relationship type.
 *   Different relationship types to the same related subject coexist; the same
 *   type to the same related subject conflicts.
 */
export function claimConflictKey(
  kind: BiographicalClaimKind,
  subject: BiographicalSubjectRef,
  value: BiographicalClaimValue,
  relatedSubject?: BiographicalSubjectRef,
): string {
  const subjectId = subjectRefIdentity(subject);
  if (kind === 'name') {
    const nameValue = value as NameClaimValue;
    return `name:${subjectId}:role:${nameValue.role}`;
  }
  if (kind === 'nickname') {
    const nicknameValue = value as NicknameClaimValue;
    return `nickname:${subjectId}:nick:${normalizeToken(nicknameValue.nickname)}:scope:${nicknameValue.scope}`;
  }
  const relationshipValue = value as RelationshipClaimValue;
  const relatedId = relatedSubject ? subjectRefIdentity(relatedSubject) : 'none';
  return `relationship:${subjectId}:related:${relatedId}:type:${normalizeToken(relationshipValue.relationshipType)}`;
}

/**
 * Validates the related-subject rule for `kind`. `relationship` requires a
 * related subject; `nickname` with `relational` scope requires one; the
 * remainder forbid one. This is the third-party-protection cardinality gate.
 */
export function assertRelatedSubjectShape(
  kind: BiographicalClaimKind,
  value: BiographicalClaimValue,
  relatedSubject: BiographicalSubjectRef | undefined,
): void {
  if (kind === 'relationship') {
    if (!relatedSubject) {
      throw new BiographicalClaimValidationError('relationship claim requires a related subject');
    }
    return;
  }
  if (kind === 'nickname') {
    const scope = (value as NicknameClaimValue).scope;
    if (scope === 'relational' && !relatedSubject) {
      throw new BiographicalClaimValidationError('relational nickname claim requires a related subject');
    }
    if (scope === 'self' && relatedSubject) {
      throw new BiographicalClaimValidationError('self nickname claim must not carry a related subject');
    }
    return;
  }
  // name
  if (relatedSubject) {
    throw new BiographicalClaimValidationError('name claim must not carry a related subject');
  }
}

export function isValidSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'string'
    && (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}
