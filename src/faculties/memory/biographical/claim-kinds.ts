import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import type {
  BiographicalClaimKind,
  BiographicalClaimValue,
  BiographicalSubjectRef,
  NameClaimValue,
  NicknameClaimValue,
  RelationshipClaimValue,
  RoleClaimValue,
  SharedLanguageClaimValue,
  StablePreferenceClaimValue,
} from './types.js';
import {
  BIOGRAPHICAL_PREFERENCE_DOMAINS,
  BIOGRAPHICAL_PREFERENCE_POLARITIES,
  BIOGRAPHICAL_ROLE_TYPES,
  BIOGRAPHICAL_SHARED_LANGUAGE_TYPES,
  BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION,
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

// Schema capacities, not mutable collection budgets. Changing one requires a
// normalizer revision because it changes which structured values are valid.
const NAME_FIELD_CODE_UNITS = 256;
const NICKNAME_FIELD_CODE_UNITS = 256;
const RELATIONSHIP_TYPE_FIELD_CODE_UNITS = 128;
const STABLE_TEXT_FIELD_CODE_UNITS = 256;

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
const ROLE_FLOOR: SensitivityLevel = 'personal';
const STABLE_PREFERENCE_FLOOR: SensitivityLevel = 'personal';
const SHARED_LANGUAGE_FLOOR: SensitivityLevel = 'personal';

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
  role: {
    kind: 'role',
    floorSensitivity: ROLE_FLOOR,
    requiresRelatedSubject: false,
  },
  'stable-preference': {
    kind: 'stable-preference',
    floorSensitivity: STABLE_PREFERENCE_FLOOR,
    requiresRelatedSubject: false,
  },
  'shared-language': {
    kind: 'shared-language',
    floorSensitivity: SHARED_LANGUAGE_FLOOR,
    requiresRelatedSubject: true,
  },
};

export function assertKnownClaimKind(kind: unknown): asserts kind is BiographicalClaimKind {
  if (
    kind !== 'name'
    && kind !== 'nickname'
    && kind !== 'relationship'
    && kind !== 'role'
    && kind !== 'stable-preference'
    && kind !== 'shared-language'
  ) {
    throw new BiographicalClaimValidationError(`Unknown biographical claim kind: ${String(kind)}`);
  }
}

function canonicalizeStableText(value: unknown, field: string): string {
  return assertNonEmptyBoundedString(value, field, STABLE_TEXT_FIELD_CODE_UNITS)
    .normalize('NFKC')
    .replace(/\s+/gu, ' ');
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
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'name', 'role']) || value.kind !== 'name') {
    throw new BiographicalClaimValidationError('name claim value must be an object with kind "name"');
  }
  const name = assertNonEmptyBoundedString(value.name, 'name', NAME_FIELD_CODE_UNITS);
  const role = value.role;
  if (role !== 'primary' && role !== 'alias') {
    throw new BiographicalClaimValidationError('name role must be one of: primary, alias');
  }
  return { kind: 'name', name, role };
}

function assertNicknameValue(value: unknown): NicknameClaimValue {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'nickname', 'scope']) || value.kind !== 'nickname') {
    throw new BiographicalClaimValidationError('nickname claim value must be an object with kind "nickname"');
  }
  const nickname = assertNonEmptyBoundedString(value.nickname, 'nickname', NICKNAME_FIELD_CODE_UNITS);
  const scope = value.scope;
  if (scope !== 'self' && scope !== 'relational') {
    throw new BiographicalClaimValidationError('nickname scope must be one of: self, relational');
  }
  return { kind: 'nickname', nickname, scope };
}

function assertRelationshipValue(value: unknown): RelationshipClaimValue {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['kind', 'relationshipType'])
    || value.kind !== 'relationship'
  ) {
    throw new BiographicalClaimValidationError('relationship claim value must be an object with kind "relationship"');
  }
  const relationshipType = assertNonEmptyBoundedString(
    value.relationshipType,
    'relationshipType',
    RELATIONSHIP_TYPE_FIELD_CODE_UNITS,
  );
  return { kind: 'relationship', relationshipType };
}

function assertRoleValue(value: unknown): RoleClaimValue {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['kind', 'schemaVersion', 'roleType', 'title'], ['organization'])
    || value.kind !== 'role'
    || value.schemaVersion !== BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION
  ) {
    throw new BiographicalClaimValidationError(
      'role claim value must use the closed role schema version 1',
    );
  }
  if (!(BIOGRAPHICAL_ROLE_TYPES as readonly unknown[]).includes(value.roleType)) {
    throw new BiographicalClaimValidationError(
      `roleType must be one of: ${BIOGRAPHICAL_ROLE_TYPES.join(', ')}`,
    );
  }
  const title = canonicalizeStableText(value.title, 'title');
  const organization = value.organization === undefined
    ? undefined
    : canonicalizeStableText(value.organization, 'organization');
  return {
    kind: 'role',
    schemaVersion: BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION,
    roleType: value.roleType as RoleClaimValue['roleType'],
    title,
    ...(organization !== undefined ? { organization } : {}),
  };
}

function assertStablePreferenceValue(value: unknown): StablePreferenceClaimValue {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['kind', 'schemaVersion', 'domain', 'target', 'polarity'])
    || value.kind !== 'stable-preference'
    || value.schemaVersion !== BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION
  ) {
    throw new BiographicalClaimValidationError(
      'stable-preference claim value must use the closed stable-preference schema version 1',
    );
  }
  if (!(BIOGRAPHICAL_PREFERENCE_DOMAINS as readonly unknown[]).includes(value.domain)) {
    throw new BiographicalClaimValidationError(
      `preference domain must be one of: ${BIOGRAPHICAL_PREFERENCE_DOMAINS.join(', ')}`,
    );
  }
  if (!(BIOGRAPHICAL_PREFERENCE_POLARITIES as readonly unknown[]).includes(value.polarity)) {
    throw new BiographicalClaimValidationError(
      `preference polarity must be one of: ${BIOGRAPHICAL_PREFERENCE_POLARITIES.join(', ')}`,
    );
  }
  return {
    kind: 'stable-preference',
    schemaVersion: BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION,
    domain: value.domain as StablePreferenceClaimValue['domain'],
    target: canonicalizeStableText(value.target, 'target'),
    polarity: value.polarity as StablePreferenceClaimValue['polarity'],
  };
}

function assertSharedLanguageValue(value: unknown): SharedLanguageClaimValue {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['kind', 'schemaVersion', 'languageType', 'phrase', 'meaning'],
    )
    || value.kind !== 'shared-language'
    || value.schemaVersion !== BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION
  ) {
    throw new BiographicalClaimValidationError(
      'shared-language claim value must use the closed shared-language schema version 1',
    );
  }
  if (!(BIOGRAPHICAL_SHARED_LANGUAGE_TYPES as readonly unknown[]).includes(value.languageType)) {
    throw new BiographicalClaimValidationError(
      `languageType must be one of: ${BIOGRAPHICAL_SHARED_LANGUAGE_TYPES.join(', ')}`,
    );
  }
  return {
    kind: 'shared-language',
    schemaVersion: BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION,
    languageType: value.languageType as SharedLanguageClaimValue['languageType'],
    phrase: canonicalizeStableText(value.phrase, 'phrase'),
    meaning: canonicalizeStableText(value.meaning, 'meaning'),
  };
}

/**
 * Validate and canonicalize a structured value for `kind`. Canonicalization is
 * preserves the existing trim-only v1 values and applies versioned NFKC plus
 * whitespace normalization to the new stable-value schemas. The envelope
 * {@link BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION} and each stable value's schema
 * version pin digest behavior.
 */
export function canonicalizeClaimValue(
  kind: BiographicalClaimKind,
  value: unknown,
): BiographicalClaimValue {
  if (kind === 'name') return assertNameValue(value);
  if (kind === 'nickname') return assertNicknameValue(value);
  if (kind === 'relationship') return assertRelationshipValue(value);
  if (kind === 'role') return assertRoleValue(value);
  if (kind === 'stable-preference') return assertStablePreferenceValue(value);
  return assertSharedLanguageValue(value);
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
 * - `name`: primary is singleton; aliases coexist by normalized alias.
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
    return nameValue.role === 'primary'
      ? `name:${subjectId}:role:primary`
      : `name:${subjectId}:role:alias:name:${normalizeToken(nameValue.name)}`;
  }
  if (kind === 'nickname') {
    const nicknameValue = value as NicknameClaimValue;
    const relatedId = relatedSubject ? subjectRefIdentity(relatedSubject) : 'none';
    return `nickname:${subjectId}:related:${relatedId}:nick:${normalizeToken(nicknameValue.nickname)}:scope:${nicknameValue.scope}`;
  }
  if (kind === 'relationship') {
    const relationshipValue = value as RelationshipClaimValue;
    const relatedId = relatedSubject ? subjectRefIdentity(relatedSubject) : 'none';
    return `relationship:${subjectId}:related:${relatedId}:type:${normalizeToken(relationshipValue.relationshipType)}`;
  }
  if (kind === 'role') {
    const roleValue = value as RoleClaimValue;
    const organization = normalizeToken(roleValue.organization ?? 'none');
    if (roleValue.roleType === 'employment' || roleValue.roleType === 'education') {
      return `role:${subjectId}:type:${roleValue.roleType}:organization:${organization}`;
    }
    return `role:${subjectId}:type:${roleValue.roleType}:organization:${organization}:title:${normalizeToken(roleValue.title)}`;
  }
  if (kind === 'stable-preference') {
    const preferenceValue = value as StablePreferenceClaimValue;
    return `stable-preference:${subjectId}:domain:${preferenceValue.domain}:target:${normalizeToken(preferenceValue.target)}`;
  }
  const languageValue = value as SharedLanguageClaimValue;
  const relatedId = relatedSubject ? subjectRefIdentity(relatedSubject) : 'none';
  return `shared-language:${subjectId}:related:${relatedId}:type:${languageValue.languageType}:phrase:${normalizeToken(languageValue.phrase)}`;
}

/** Values sharing a topic key may still coexist when they express the same
 * non-exclusive preference direction. Opposing directions remain conflicts. */
export function claimValuesCanCoexist(
  kind: BiographicalClaimKind,
  left: BiographicalClaimValue,
  right: BiographicalClaimValue,
): boolean {
  if (
    kind !== 'stable-preference'
    || left.kind !== 'stable-preference'
    || right.kind !== 'stable-preference'
  ) return false;
  const leftPolarity = left.polarity;
  const rightPolarity = right.polarity;
  const leftPositive = leftPolarity === 'likes' || leftPolarity === 'prefers';
  const rightPositive = rightPolarity === 'likes' || rightPolarity === 'prefers';
  return leftPositive === rightPositive;
}

function assertCompanionContactDyad(
  subject: BiographicalSubjectRef,
  relatedSubject: BiographicalSubjectRef,
  kind: BiographicalClaimKind,
): void {
  if (subject.kind === relatedSubject.kind) {
    throw new BiographicalClaimValidationError(
      `${kind} claim must describe exactly one companion-contact dyad`,
    );
  }
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
  subject?: BiographicalSubjectRef,
): void {
  if (kind === 'relationship') {
    if (!relatedSubject) {
      throw new BiographicalClaimValidationError('relationship claim requires a related subject');
    }
    if (subject) assertCompanionContactDyad(subject, relatedSubject, kind);
    return;
  }
  if (kind === 'nickname') {
    const scope = (value as NicknameClaimValue).scope;
    if (scope === 'relational' && !relatedSubject) {
      throw new BiographicalClaimValidationError('relational nickname claim requires a related subject');
    }
    if (scope === 'relational' && relatedSubject && subject) {
      assertCompanionContactDyad(subject, relatedSubject, kind);
    }
    if (scope === 'self' && relatedSubject) {
      throw new BiographicalClaimValidationError('self nickname claim must not carry a related subject');
    }
    return;
  }
  if (kind === 'shared-language') {
    if (!relatedSubject) {
      throw new BiographicalClaimValidationError('shared-language claim requires a related subject');
    }
    if (subject) {
      assertCompanionContactDyad(subject, relatedSubject, kind);
      if (subject.kind !== 'contact' || relatedSubject.kind !== 'companion') {
        throw new BiographicalClaimValidationError(
          'shared-language claim must use contact subject and companion related subject',
        );
      }
    }
    return;
  }
  if (relatedSubject) {
    throw new BiographicalClaimValidationError(`${kind} claim must not carry a related subject`);
  }
}

type BiographicalClaimValidityRule = 'durable' | 'temporal-role';

function claimKindValidityRule(
  kind: BiographicalClaimKind,
): BiographicalClaimValidityRule {
  return kind === 'role' ? 'temporal-role' : 'durable';
}

export function assertClaimValidityRule(
  kind: BiographicalClaimKind,
  interval: { readonly validFrom?: string; readonly validTo?: string },
): void {
  if (claimKindValidityRule(kind) === 'temporal-role' && interval.validFrom === undefined) {
    throw new BiographicalClaimValidationError('role claim requires validFrom');
  }
}

export function isValidSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'string'
    && (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}
