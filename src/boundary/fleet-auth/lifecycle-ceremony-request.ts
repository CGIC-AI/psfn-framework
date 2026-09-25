import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { FleetAuthRole } from '../../system/config/fleet-auth-config.js';
import type { VerifiedProviderProof } from '../../persistence/postgres/fleet-auth/authority-lifecycle-types.js';

const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Wire contract of the fleet-auth lifecycle ceremonies: the SSO-session
 * ceremonies and the audited ADMIN_TOKEN operator's key-mode ceremonies.
 */
type SupportedLifecycleAction =
  | 'binding.activate'
  | 'provider.add'
  | 'provider.relink'
  | 'provider.replace'
  | 'role.grant'
  | 'role.change'
  | 'role.revoke';

interface CeremonyBase {
  action: SupportedLifecycleAction;
  ceremonyId: string;
  companionId: string;
  reason: string;
}

export type FleetAuthLifecycleCeremonyRequest =
  | (CeremonyBase & {
      action: 'binding.activate';
      targetPrincipalId: string;
      contactId: string;
      bindingId: string;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'provider.add' | 'provider.relink';
      contactId: string;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'provider.replace';
      contactId: string;
      currentProvider: VerifiedProviderProof;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'role.grant';
      targetPrincipalId: string;
      grantId: string;
      role: FleetAuthRole;
    })
  | (CeremonyBase & {
      action: 'role.change';
      targetPrincipalId: string;
      grantId: string;
      newGrantId: string;
      currentRole: FleetAuthRole;
      role: FleetAuthRole;
    })
  | (CeremonyBase & {
      action: 'role.revoke';
      targetPrincipalId: string;
      grantId: string;
      currentRole: FleetAuthRole;
    });

function providerProof(value: unknown, field: string): VerifiedProviderProof {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertNoUnknownKeys(
    value,
    ['provider', 'subjectId', 'callbackTransactionId', 'proofDigest'],
    field,
  );
  if (value.provider !== 'discord'
    || typeof value.subjectId !== 'string'
    || !SUBJECT_PATTERN.test(value.subjectId)
    || typeof value.callbackTransactionId !== 'string'
    || !isRfc4122Uuid(value.callbackTransactionId)
    || typeof value.proofDigest !== 'string'
    || !DIGEST_PATTERN.test(value.proofDigest)) {
    throw new Error(`${field} is invalid`);
  }
  return value as unknown as VerifiedProviderProof;
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('reason must be a string');
  const reason = value.trim();
  if (!reason || reason.length > 512 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new Error('reason is invalid');
  }
  return reason;
}

function contactId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('contactId is invalid');
  }
  return value;
}

function role(value: unknown, field: string): FleetAuthRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member' && value !== 'guest') {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function parseFleetAuthLifecycleCeremonyRequest(
  input: unknown,
): FleetAuthLifecycleCeremonyRequest {
  if (!isRecord(input)) throw new Error('Lifecycle ceremony request must be an object');
  const common = ['action', 'ceremonyId', 'companionId', 'reason'] as const;
  if (typeof input.ceremonyId !== 'string' || !isRfc4122Uuid(input.ceremonyId)
    || typeof input.companionId !== 'string' || !isRfc4122Uuid(input.companionId)) {
    throw new Error('Lifecycle ceremony scope is invalid');
  }
  const reason = boundedReason(input.reason);
  if (input.action === 'binding.activate') {
    assertNoUnknownKeys(input, [
      ...common,
      'targetPrincipalId',
      'contactId',
      'bindingId',
      'newProvider',
    ], 'lifecycleCeremony');
    if (typeof input.targetPrincipalId !== 'string' || !isRfc4122Uuid(input.targetPrincipalId)
      || typeof input.bindingId !== 'string' || !isRfc4122Uuid(input.bindingId)
      || typeof input.contactId !== 'string' || !input.contactId
      || input.contactId.length > 256) {
      throw new Error('Binding activation scope is invalid');
    }
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: input.targetPrincipalId,
      contactId: input.contactId,
      bindingId: input.bindingId,
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'provider.add' || input.action === 'provider.relink') {
    assertNoUnknownKeys(input, [...common, 'contactId', 'newProvider'], 'lifecycleCeremony');
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      contactId: contactId(input.contactId),
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'provider.replace') {
    assertNoUnknownKeys(
      input,
      [...common, 'contactId', 'currentProvider', 'newProvider'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      contactId: contactId(input.contactId),
      currentProvider: providerProof(input.currentProvider, 'currentProvider'),
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'role.grant') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'role'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId: uuid(input.grantId, 'grantId'),
      role: role(input.role, 'role'),
    };
  }
  if (input.action === 'role.change') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'newGrantId', 'currentRole', 'role'],
      'lifecycleCeremony',
    );
    const currentRole = role(input.currentRole, 'currentRole');
    const newRole = role(input.role, 'role');
    const grantId = uuid(input.grantId, 'grantId');
    const newGrantId = uuid(input.newGrantId, 'newGrantId');
    if (currentRole === newRole || grantId === newGrantId) {
      throw new Error('Role change must replace both role and grant identity');
    }
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId,
      newGrantId,
      currentRole,
      role: newRole,
    };
  }
  if (input.action === 'role.revoke') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'currentRole'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId: uuid(input.grantId, 'grantId'),
      currentRole: role(input.currentRole, 'currentRole'),
    };
  }
  throw new Error('Lifecycle ceremony action is unknown');
}



/**
 * A lifecycle ceremony the audited ADMIN_TOKEN operator performs directly with
 * the key (key-or-SSO ruling). Binding activation carries no OAuth proof: it
 * names the pending principal's own Discord subject, already on record from
 * its SSO login. Provider link/relink/replace prove control of a Discord
 * account and exist only in SSO mode, so they are not operator requests.
 */
export type AdminTokenOperatorCeremonyRequest =
  | {
    action: 'binding.activate';
    ceremonyId: string;
    companionId: string;
    reason: string;
    targetPrincipalId: string;
    contactId: string;
    bindingId: string;
    providerSubjectId: string;
  }
  | Extract<FleetAuthLifecycleCeremonyRequest, { action: 'role.grant' | 'role.change' | 'role.revoke' }>;

export function parseAdminTokenOperatorCeremonyRequest(
  input: unknown,
): AdminTokenOperatorCeremonyRequest {
  if (!isRecord(input)) throw new Error('Lifecycle ceremony request must be an object');
  if (input.action === 'binding.activate') {
    assertNoUnknownKeys(input, [
      'action', 'ceremonyId', 'companionId', 'reason',
      'targetPrincipalId', 'contactId', 'bindingId', 'providerSubjectId',
    ], 'lifecycleCeremony');
    if (typeof input.ceremonyId !== 'string' || !isRfc4122Uuid(input.ceremonyId)
      || typeof input.companionId !== 'string' || !isRfc4122Uuid(input.companionId)
      || typeof input.targetPrincipalId !== 'string' || !isRfc4122Uuid(input.targetPrincipalId)
      || typeof input.bindingId !== 'string' || !isRfc4122Uuid(input.bindingId)
      || typeof input.contactId !== 'string' || !input.contactId || input.contactId.length > 256
      || typeof input.providerSubjectId !== 'string'
      || !SUBJECT_PATTERN.test(input.providerSubjectId)) {
      throw new Error('Binding activation scope is invalid');
    }
    return {
      action: 'binding.activate',
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason: boundedReason(input.reason),
      targetPrincipalId: input.targetPrincipalId,
      contactId: input.contactId,
      bindingId: input.bindingId,
      providerSubjectId: input.providerSubjectId,
    };
  }
  const parsed = parseFleetAuthLifecycleCeremonyRequest(input);
  if (parsed.action !== 'role.grant' && parsed.action !== 'role.change' && parsed.action !== 'role.revoke') {
    throw new Error('Provider ceremonies prove a Discord account and are SSO-mode only');
  }
  return parsed;
}
