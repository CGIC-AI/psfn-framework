import { timingSafeEqual } from 'node:crypto';
import { digestFleetAuthVerifiedProviderProof } from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import {
  parseVerifiedDiscordContactAuthoritySnapshot,
  type VerifiedDiscordContactAuthoritySnapshot,
} from '../../../shared/contracts/contact-authority-snapshot.js';
import type { FleetAuthRole } from '../../../system/config/fleet-auth-config.js';
export type { FleetAuthRole } from '../../../system/config/fleet-auth-config.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

export interface PrincipalAuthorityClaim {
  principalId: string;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
}

export interface VerifiedProviderProof {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
  proofDigest: string;
}

export interface ActorSessionAuthorityClaim {
  sessionId: string;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
  globalAuthEpoch: number;
  provider: 'discord';
  providerSubjectId: string;
}

export function digestVerifiedProviderProof(input: {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
}): string {
  return digestFleetAuthVerifiedProviderProof(input);
}

/**
 * The audited ADMIN_TOKEN operator as the approving authority of a lifecycle
 * ceremony (psfn-framework-ja7n0). It carries no principal and no session: its
 * evidence is the durable `admin_token_operator` approval audit row, which is
 * bound to exactly this decision id, ceremony, action, companion and authority
 * snapshot. The operator approves; it never supplies the subject's proof.
 */
interface AdminTokenOperatorApproval {
  kind: 'admin_token_operator';
  authorizationEventId: string;
}

/**
 * Ceremony actions the ADMIN_TOKEN operator performs directly with the key;
 * everything else rejects (key-or-SSO ruling). The operator's binding
 * activation needs no OAuth proof: the pending principal's own Discord subject
 * is already on record from its SSO login. Provider link/relink/replace prove
 * control of a Discord account and are SSO-mode features only.
 */
export const ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS = [
  'binding.activate',
  'role.grant',
  'role.change',
  'role.revoke',
] as const;

/** The fleet action an ADMIN_TOKEN approval of a ceremony action is audited under. */
export function adminTokenLifecycleApprovalAction(
  action: typeof ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS[number],
): 'contacts.bind' | 'roles.manage' {
  return action === 'binding.activate' ? 'contacts.bind' : 'roles.manage';
}

interface LifecycleDecisionCommon {
  verification: 'gateway_verified';
  decisionId: string;
  ceremonyId: string;
  target: PrincipalAuthorityClaim;
  authorityGeneration: number;
  globalAuthEpoch: number;
  reasonDigest: string;
  decidedAt: Date;
}

/** A human principal acting under its exact live SSO session (unchanged shape). */
interface PrincipalActorDecision extends LifecycleDecisionCommon {
  actor: PrincipalAuthorityClaim;
  actorSession: ActorSessionAuthorityClaim;
  operator?: never;
}

interface AdminTokenOperatorDecision extends LifecycleDecisionCommon {
  operator: AdminTokenOperatorApproval;
  actor?: never;
  actorSession?: never;
}

type LifecycleDecisionBase = PrincipalActorDecision | AdminTokenOperatorDecision;

/** Narrow a decision to its human principal actor; operator approvals have none. */
export function lifecyclePrincipalActor(
  decision: VerifiedFleetAuthLifecycleDecision,
): { actor: PrincipalAuthorityClaim; actorSession: ActorSessionAuthorityClaim } | null {
  return decision.operator ? null : { actor: decision.actor!, actorSession: decision.actorSession! };
}

export type VerifiedFleetAuthLifecycleDecision =
  | (PrincipalActorDecision & {
    action: 'binding.activate';
    companionId: string;
    contactId: string;
    bindingId: string;
    newProvider: VerifiedProviderProof;
    contactAuthority: VerifiedDiscordContactAuthoritySnapshot;
  })
  | (AdminTokenOperatorDecision & {
    action: 'binding.activate';
    companionId: string;
    contactId: string;
    bindingId: string;
    /** The pending principal's own Discord subject, recorded by its SSO login. */
    providerSubjectId: string;
  })
  | (LifecycleDecisionBase & {
    action: 'provider.add' | 'provider.relink';
    companionId: string;
    contactId: string;
    newProvider: VerifiedProviderProof;
    contactAuthority: VerifiedDiscordContactAuthoritySnapshot;
  })
  | (LifecycleDecisionBase & {
    action: 'provider.replace';
    companionId: string;
    contactId: string;
    currentProvider: VerifiedProviderProof;
    newProvider: VerifiedProviderProof;
    contactAuthority: VerifiedDiscordContactAuthoritySnapshot;
  })
  | (LifecycleDecisionBase & {
    action: 'provider.unlink';
    currentProvider: VerifiedProviderProof;
  })
  | (LifecycleDecisionBase & {
    action: 'role.grant';
    companionId: string;
    grantId: string;
    role: FleetAuthRole;
  })
  | (LifecycleDecisionBase & {
    action: 'role.change';
    companionId: string;
    grantId: string;
    newGrantId: string;
    currentRole: FleetAuthRole;
    role: FleetAuthRole;
  })
  | (LifecycleDecisionBase & {
    action: 'role.revoke';
    companionId: string;
    grantId: string;
    currentRole: FleetAuthRole;
  })
  | (LifecycleDecisionBase & {
    action: 'binding.conflict_suspend' | 'contact.unlink';
    companionId: string;
    contactId: string;
    bindingId: string;
  })
  | (LifecycleDecisionBase & {
    action: 'contact.merge';
    companionId: string;
    sourceContactId: string;
    canonicalContactId: string;
  })
  | (LifecycleDecisionBase & {
    action: 'contact.delete';
    companionId: string;
    contactId: string;
  })
  | (LifecycleDecisionBase & {
    action: 'companion.remove' | 'companion.readd';
    companionId: string;
  })
  | (LifecycleDecisionBase & {
    action: 'principal.merge';
    source: PrincipalAuthorityClaim;
    canonicalProvider: VerifiedProviderProof;
    sourceProvider: VerifiedProviderProof;
  });

export interface FleetAuthLifecycleResult {
  decisionId: string;
  action: VerifiedFleetAuthLifecycleDecision['action'];
  authorityGeneration: number;
  globalAuthEpoch: number;
  target: PrincipalAuthorityClaim;
}

const COMMON_KEYS = [
  'verification',
  'action',
  'decisionId',
  'ceremonyId',
  'target',
  'authorityGeneration',
  'globalAuthEpoch',
  'reasonDigest',
  'decidedAt',
] as const;

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) {
    throw new Error(`${field} must be an RFC-4122 UUID`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${field} must be a SHA-256 digest`);
  }
}

function assertRole(value: unknown, field: string): asserts value is FleetAuthRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member' && value !== 'guest') {
    throw new Error(`${field} is unknown`);
  }
}

function assertPrincipalClaim(value: unknown, field: string): PrincipalAuthorityClaim {
  const claim = assertRecord(value, field);
  assertNoUnknownKeys(claim, [
    'principalId',
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ], field, { errorPrefix: 'Invalid fleet-auth lifecycle decision' });
  assertUuid(claim.principalId, `${field}.principalId`);
  for (const version of [
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ] as const) {
    assertPositiveInteger(claim[version], `${field}.${version}`);
  }
  return claim as unknown as PrincipalAuthorityClaim;
}

function assertProviderProof(value: unknown, field: string): VerifiedProviderProof {
  const proof = assertRecord(value, field);
  assertNoUnknownKeys(proof, [
    'provider',
    'subjectId',
    'callbackTransactionId',
    'proofDigest',
  ], field, { errorPrefix: 'Invalid fleet-auth lifecycle decision' });
  if (proof.provider !== 'discord') throw new Error(`${field}.provider is unknown`);
  if (typeof proof.subjectId !== 'string' || !DISCORD_SUBJECT_PATTERN.test(proof.subjectId)) {
    throw new Error(`${field}.subjectId is invalid`);
  }
  assertUuid(proof.callbackTransactionId, `${field}.callbackTransactionId`);
  assertDigest(proof.proofDigest, `${field}.proofDigest`);
  const expectedProofDigest = digestVerifiedProviderProof({
    provider: proof.provider,
    subjectId: proof.subjectId,
    callbackTransactionId: proof.callbackTransactionId,
  });
  if (!timingSafeEqual(
    Buffer.from(proof.proofDigest, 'hex'),
    Buffer.from(expectedProofDigest, 'hex'),
  )) {
    throw new Error(`${field}.proofDigest is not bound to its exact callback subject`);
  }
  return proof as unknown as VerifiedProviderProof;
}

function assertActorSession(value: unknown): ActorSessionAuthorityClaim {
  const session = assertRecord(value, 'actorSession');
  assertNoUnknownKeys(session, [
    'sessionId',
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
    'globalAuthEpoch',
    'provider',
    'providerSubjectId',
  ], 'actorSession', { errorPrefix: 'Invalid fleet-auth lifecycle decision' });
  assertUuid(session.sessionId, 'actorSession.sessionId');
  for (const version of [
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
    'globalAuthEpoch',
  ] as const) {
    assertPositiveInteger(session[version], `actorSession.${version}`);
  }
  if (session.provider !== 'discord'
    || typeof session.providerSubjectId !== 'string'
    || !DISCORD_SUBJECT_PATTERN.test(session.providerSubjectId)) {
    throw new Error('actorSession provider binding is invalid');
  }
  return session as unknown as ActorSessionAuthorityClaim;
}

function assertOperatorApproval(decision: Record<string, unknown>): void {
  const operator = assertRecord(decision.operator, 'operator');
  assertNoUnknownKeys(operator, ['kind', 'authorizationEventId'], 'operator', {
    errorPrefix: 'Invalid fleet-auth lifecycle decision',
  });
  if (operator.kind !== 'admin_token_operator') throw new Error('operator.kind is unknown');
  assertUuid(operator.authorizationEventId, 'operator.authorizationEventId');
  if (operator.authorizationEventId === decision.decisionId) {
    throw new Error('operator approval audit and decision identities must be distinct');
  }
  if (!(ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS as readonly unknown[]).includes(decision.action)) {
    throw new Error('ADMIN_TOKEN operator cannot approve this lifecycle action');
  }
}

function assertPrincipalActor(decision: Record<string, unknown>): void {
  const actorSession = assertActorSession(decision.actorSession);
  const actor = assertPrincipalClaim(decision.actor, 'actor');
  if (actorSession.authnVersion !== actor.authnVersion
    || actorSession.authzVersion !== actor.authzVersion
    || actorSession.bindingVersion !== actor.bindingVersion
    || actorSession.grantVersion !== actor.grantVersion
    || actorSession.policyVersion !== actor.policyVersion) {
    throw new Error('actorSession versions do not match the actor authority claim');
  }
  if (actorSession.globalAuthEpoch !== decision.globalAuthEpoch) {
    throw new Error('actorSession global epoch does not match the decision');
  }
}

function assertCommon(decision: Record<string, unknown>): void {
  if (decision.verification !== 'gateway_verified') {
    throw new Error('verification must be gateway_verified');
  }
  assertUuid(decision.decisionId, 'decisionId');
  assertUuid(decision.ceremonyId, 'ceremonyId');
  assertPrincipalClaim(decision.target, 'target');
  assertPositiveInteger(decision.authorityGeneration, 'authorityGeneration');
  assertPositiveInteger(decision.globalAuthEpoch, 'globalAuthEpoch');
  // Exactly one approving authority: a principal session or the operator door.
  if (Object.hasOwn(decision, 'operator')) {
    if (Object.hasOwn(decision, 'actor') || Object.hasOwn(decision, 'actorSession')) {
      throw new Error('operator approval cannot also carry a principal actor');
    }
    assertOperatorApproval(decision);
  } else {
    assertPrincipalActor(decision);
  }
  assertDigest(decision.reasonDigest, 'reasonDigest');
  if (!(decision.decidedAt instanceof Date) || Number.isNaN(decision.decidedAt.getTime())) {
    throw new Error('decidedAt must be a valid Date');
  }
}

function assertIds(decision: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) assertUuid(decision[field], field);
}

function assertContactId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error(`${field} must be a bounded contact identifier`);
  }
}

function assertDecisionKeys(
  decision: Record<string, unknown>,
  additional: readonly string[],
): void {
  const approval = Object.hasOwn(decision, 'operator')
    ? ['operator'] as const
    : ['actor', 'actorSession'] as const;
  assertNoUnknownKeys(decision, [...COMMON_KEYS, ...approval, ...additional], 'decision', {
    errorPrefix: 'Invalid fleet-auth lifecycle decision',
  });
}

export function assertVerifiedFleetAuthLifecycleDecision(
  value: unknown,
): VerifiedFleetAuthLifecycleDecision {
  const decision = assertRecord(value, 'decision');
  assertCommon(decision);
  switch (decision.action) {
    case 'binding.activate':
      if (Object.hasOwn(decision, 'operator')) {
        assertDecisionKeys(decision, ['companionId', 'contactId', 'bindingId', 'providerSubjectId']);
        assertIds(decision, ['companionId', 'bindingId']);
        assertContactId(decision.contactId, 'contactId');
        if (typeof decision.providerSubjectId !== 'string'
          || !DISCORD_SUBJECT_PATTERN.test(decision.providerSubjectId)) {
          throw new Error('binding.activate providerSubjectId is invalid');
        }
        break;
      }
      assertDecisionKeys(decision, [
        'companionId',
        'contactId',
        'bindingId',
        'newProvider',
        'contactAuthority',
      ]);
      assertIds(decision, ['companionId', 'bindingId']);
      assertContactId(decision.contactId, 'contactId');
      {
        const provider = assertProviderProof(decision.newProvider, 'newProvider');
        const contactAuthority = parseVerifiedDiscordContactAuthoritySnapshot(
          decision.contactAuthority,
        );
        if (contactAuthority.contactId !== decision.contactId
          || contactAuthority.providerSubjectId !== provider.subjectId) {
          throw new Error('binding.activate contact authority does not match its exact tuple');
        }
      }
      break;
    case 'provider.add':
    case 'provider.relink': {
      assertDecisionKeys(decision, [
        'companionId',
        'contactId',
        'newProvider',
        'contactAuthority',
      ]);
      assertIds(decision, ['companionId']);
      assertContactId(decision.contactId, 'contactId');
      const provider = assertProviderProof(decision.newProvider, 'newProvider');
      const contactAuthority = parseVerifiedDiscordContactAuthoritySnapshot(
        decision.contactAuthority,
      );
      if (contactAuthority.contactId !== decision.contactId
        || contactAuthority.providerSubjectId !== provider.subjectId) {
        throw new Error(`${decision.action} contact authority does not match its exact tuple`);
      }
      break;
    }
    case 'provider.replace': {
      assertDecisionKeys(decision, [
        'companionId',
        'contactId',
        'currentProvider',
        'newProvider',
        'contactAuthority',
      ]);
      assertIds(decision, ['companionId']);
      assertContactId(decision.contactId, 'contactId');
      const current = assertProviderProof(decision.currentProvider, 'currentProvider');
      const replacement = assertProviderProof(decision.newProvider, 'newProvider');
      const contactAuthority = parseVerifiedDiscordContactAuthoritySnapshot(
        decision.contactAuthority,
      );
      if (contactAuthority.contactId !== decision.contactId
        || contactAuthority.providerSubjectId !== replacement.subjectId) {
        throw new Error('provider.replace contact authority does not match its exact tuple');
      }
      if (current.subjectId === replacement.subjectId) {
        throw new Error('provider.replace requires distinct current and new subjects');
      }
      if (current.callbackTransactionId === replacement.callbackTransactionId) {
        throw new Error('provider.replace requires distinct current and new callback proofs');
      }
      break;
    }
    case 'provider.unlink':
      assertDecisionKeys(decision, ['currentProvider']);
      assertProviderProof(decision.currentProvider, 'currentProvider');
      break;
    case 'role.grant':
      assertDecisionKeys(decision, ['companionId', 'grantId', 'role']);
      assertIds(decision, ['companionId', 'grantId']);
      assertRole(decision.role, 'role');
      break;
    case 'role.change':
      assertDecisionKeys(decision, ['companionId', 'grantId', 'newGrantId', 'currentRole', 'role']);
      assertIds(decision, ['companionId', 'grantId', 'newGrantId']);
      assertRole(decision.currentRole, 'currentRole');
      assertRole(decision.role, 'role');
      if (decision.currentRole === decision.role) {
        throw new Error('role.change requires a different role');
      }
      if (decision.grantId === decision.newGrantId) {
        throw new Error('role.change requires a new grant identity');
      }
      break;
    case 'role.revoke':
      assertDecisionKeys(decision, ['companionId', 'grantId', 'currentRole']);
      assertIds(decision, ['companionId', 'grantId']);
      assertRole(decision.currentRole, 'currentRole');
      break;
    case 'binding.conflict_suspend':
    case 'contact.unlink':
      assertDecisionKeys(decision, ['companionId', 'contactId', 'bindingId']);
      assertIds(decision, ['companionId', 'bindingId']);
      assertContactId(decision.contactId, 'contactId');
      break;
    case 'contact.merge':
      assertDecisionKeys(decision, ['companionId', 'sourceContactId', 'canonicalContactId']);
      assertIds(decision, ['companionId']);
      assertContactId(decision.sourceContactId, 'sourceContactId');
      assertContactId(decision.canonicalContactId, 'canonicalContactId');
      if (decision.sourceContactId === decision.canonicalContactId) {
        throw new Error('contact.merge requires distinct source and canonical contacts');
      }
      break;
    case 'contact.delete':
      assertDecisionKeys(decision, ['companionId', 'contactId']);
      assertIds(decision, ['companionId']);
      assertContactId(decision.contactId, 'contactId');
      break;
    case 'companion.remove':
    case 'companion.readd':
      assertDecisionKeys(decision, ['companionId']);
      assertIds(decision, ['companionId']);
      break;
    case 'principal.merge': {
      assertDecisionKeys(decision, ['source', 'canonicalProvider', 'sourceProvider']);
      const source = assertPrincipalClaim(decision.source, 'source');
      const target = assertPrincipalClaim(decision.target, 'target');
      const canonicalProvider = assertProviderProof(
        decision.canonicalProvider,
        'canonicalProvider',
      );
      const sourceProvider = assertProviderProof(decision.sourceProvider, 'sourceProvider');
      if (source.principalId === target.principalId) {
        throw new Error('principal.merge requires distinct source and canonical principals');
      }
      if (canonicalProvider.subjectId === sourceProvider.subjectId
        || canonicalProvider.callbackTransactionId === sourceProvider.callbackTransactionId) {
        throw new Error('principal.merge requires distinct canonical and source proofs');
      }
      break;
    }
    default:
      throw new Error('action is unknown');
  }
  return decision as unknown as VerifiedFleetAuthLifecycleDecision;
}
