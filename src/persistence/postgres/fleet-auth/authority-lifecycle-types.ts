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

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

export type FleetAuthRole = 'owner' | 'admin' | 'member' | 'guest';

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

export interface UnavailableProviderAuthorityClaim {
  provider: 'discord';
  subjectId: string;
  authorityGeneration: number;
}

export interface TrustedHostProviderRecoveryEvidence {
  oneTimeCredential: string;
  confirmation: 'provider.recover';
  webAuthnReceipt: string;
  credentialIdHash: string;
  credentialGeneration: number;
  credentialFloorGeneration: number;
}

export function digestVerifiedProviderProof(input: {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
}): string {
  return digestFleetAuthVerifiedProviderProof(input);
}

interface LifecycleDecisionBase {
  verification: 'gateway_verified';
  decisionId: string;
  ceremonyId: string;
  actor: PrincipalAuthorityClaim;
  actorSession: ActorSessionAuthorityClaim;
  target: PrincipalAuthorityClaim;
  authorityGeneration: number;
  globalAuthEpoch: number;
  reasonDigest: string;
  decidedAt: Date;
}

export type VerifiedFleetAuthLifecycleDecision =
  | (LifecycleDecisionBase & {
    action: 'binding.activate';
    companionId: string;
    contactId: string;
    bindingId: string;
    newProvider: VerifiedProviderProof;
    contactAuthority: VerifiedDiscordContactAuthoritySnapshot;
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
    action: 'provider.recover';
    companionId: string;
    unavailableProvider: UnavailableProviderAuthorityClaim;
    newProvider: VerifiedProviderProof;
    recovery: TrustedHostProviderRecoveryEvidence;
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

const BASE_KEYS = [
  'verification',
  'action',
  'decisionId',
  'ceremonyId',
  'actor',
  'actorSession',
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

function assertUnavailableProvider(
  value: unknown,
  field: string,
): UnavailableProviderAuthorityClaim {
  const claim = assertRecord(value, field);
  assertNoUnknownKeys(claim, ['provider', 'subjectId', 'authorityGeneration'], field, {
    errorPrefix: 'Invalid fleet-auth lifecycle decision',
  });
  if (claim.provider !== 'discord'
    || typeof claim.subjectId !== 'string'
    || !DISCORD_SUBJECT_PATTERN.test(claim.subjectId)) {
    throw new Error(`${field} provider binding is invalid`);
  }
  assertPositiveInteger(claim.authorityGeneration, `${field}.authorityGeneration`);
  return claim as unknown as UnavailableProviderAuthorityClaim;
}

function assertProviderRecoveryEvidence(value: unknown): TrustedHostProviderRecoveryEvidence {
  const evidence = assertRecord(value, 'recovery');
  assertNoUnknownKeys(evidence, [
    'oneTimeCredential',
    'confirmation',
    'webAuthnReceipt',
    'credentialIdHash',
    'credentialGeneration',
    'credentialFloorGeneration',
  ], 'recovery', { errorPrefix: 'Invalid fleet-auth lifecycle decision' });
  if (typeof evidence.oneTimeCredential !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(evidence.oneTimeCredential)
    || evidence.confirmation !== 'provider.recover'
    || typeof evidence.webAuthnReceipt !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(evidence.webAuthnReceipt)) {
    throw new Error('recovery trusted-host evidence is invalid');
  }
  assertDigest(evidence.credentialIdHash, 'recovery.credentialIdHash');
  assertPositiveInteger(evidence.credentialGeneration, 'recovery.credentialGeneration');
  assertPositiveInteger(evidence.credentialFloorGeneration, 'recovery.credentialFloorGeneration');
  return evidence as unknown as TrustedHostProviderRecoveryEvidence;
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

function assertCommon(decision: Record<string, unknown>): void {
  if (decision.verification !== 'gateway_verified') {
    throw new Error('verification must be gateway_verified');
  }
  assertUuid(decision.decisionId, 'decisionId');
  assertUuid(decision.ceremonyId, 'ceremonyId');
  const actorSession = assertActorSession(decision.actorSession);
  const actor = assertPrincipalClaim(decision.actor, 'actor');
  if (actorSession.authnVersion !== actor.authnVersion
    || actorSession.authzVersion !== actor.authzVersion
    || actorSession.bindingVersion !== actor.bindingVersion
    || actorSession.grantVersion !== actor.grantVersion
    || actorSession.policyVersion !== actor.policyVersion) {
    throw new Error('actorSession versions do not match the actor authority claim');
  }
  assertPrincipalClaim(decision.target, 'target');
  assertPositiveInteger(decision.authorityGeneration, 'authorityGeneration');
  assertPositiveInteger(decision.globalAuthEpoch, 'globalAuthEpoch');
  if (actorSession.globalAuthEpoch !== decision.globalAuthEpoch) {
    throw new Error('actorSession global epoch does not match the decision');
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
  assertNoUnknownKeys(decision, [...BASE_KEYS, ...additional], 'decision', {
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
    case 'provider.recover': {
      assertDecisionKeys(decision, [
        'companionId',
        'unavailableProvider',
        'newProvider',
        'recovery',
      ]);
      assertIds(decision, ['companionId']);
      const unavailable = assertUnavailableProvider(
        decision.unavailableProvider,
        'unavailableProvider',
      );
      const replacement = assertProviderProof(decision.newProvider, 'newProvider');
      assertProviderRecoveryEvidence(decision.recovery);
      const actorSession = decision.actorSession as ActorSessionAuthorityClaim;
      const actorSessionProvider: unknown = actorSession.provider;
      if (unavailable.subjectId === replacement.subjectId
        || actorSessionProvider !== unavailable.provider
        || actorSession.providerSubjectId !== unavailable.subjectId) {
        throw new Error('provider.recover provider subjects are not exactly bound');
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
