import { isRecord, isRfc4122Uuid } from '../utils/types.js';

export interface HubDeviceAssertionExpectedBinding {
  deviceId: string;
  enrollmentVersion: number;
  enrollmentStatus: 'active' | 'revoked';
  companionId: string;
  sessionId: string;
  placeId?: string;
}

export interface HubDevicePrincipal {
  kind: 'hub_device';
  issuer: string;
  keyId: string;
  deviceId: string;
  enrollmentVersion: number;
  enrollmentAssurance: 'device_credential';
  placeId?: string;
  audience: string;
  companionId: string;
  sessionId: string;
  issuedAt: Date;
  expiresAt: Date;
  jti: string;
}

/** JSON-safe form carried across the authenticated gateway-to-agent RPC. */
export interface HubDevicePrincipalSnapshot extends Omit<HubDevicePrincipal, 'issuedAt' | 'expiresAt'> {
  issuedAt: string;
  expiresAt: string;
}

export interface HubDeviceAttachmentSnapshot {
  readonly attachmentId: string;
  readonly disposition: 'created' | 'retry' | 'guest_created' | 'human_detached';
  readonly deviceActor: Readonly<{
    kind: 'hub_device';
    principal: Readonly<HubDevicePrincipalSnapshot>;
    connectionId: string;
  }>;
  readonly actor: Readonly<{
    kind: 'human';
    principalId: string;
    companionId: string;
    providerSubject: Readonly<{ provider: 'discord'; subjectId: string }>;
    contact: Readonly<{ bindingId: string; contactId: string; bindingVersion: number }>;
    operator: Readonly<{
      grantId: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
      grantVersion: number;
    }>;
    session: Readonly<{ recordId: string; authorityGeneration: number; globalAuthEpoch: number }>;
  } | {
    kind: 'guest';
    companionId: string;
  }>;
  readonly channel: Readonly<{
    source: 'server';
    id: string;
    companionId: string;
  }>;
}

export function isHubDevicePrincipalSnapshot(value: unknown): value is HubDevicePrincipalSnapshot {
  return isRecord(value)
    && Object.keys(value).every(key => [
      'kind', 'issuer', 'keyId', 'deviceId', 'enrollmentVersion',
      'enrollmentAssurance', 'placeId', 'audience', 'companionId',
      'sessionId', 'issuedAt', 'expiresAt', 'jti',
    ].includes(key))
    && value.kind === 'hub_device'
    && typeof value.issuer === 'string'
    && typeof value.keyId === 'string'
    && typeof value.deviceId === 'string'
    && Number.isSafeInteger(value.enrollmentVersion)
    && value.enrollmentAssurance === 'device_credential'
    && (value.placeId === undefined || typeof value.placeId === 'string')
    && typeof value.audience === 'string'
    && typeof value.companionId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.issuedAt === 'string'
    && Number.isFinite(Date.parse(value.issuedAt))
    && typeof value.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt))
    && Date.parse(value.expiresAt) > Date.now()
    && typeof value.jti === 'string';
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && [...keys].sort().every((key, index) => key === actual[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function isHubDeviceAttachmentSnapshot(value: unknown): value is HubDeviceAttachmentSnapshot {
  if (!isRecord(value)
    || !hasExactKeys(value, ['attachmentId', 'disposition', 'deviceActor', 'actor', 'channel'])
    || !isRfc4122Uuid(value.attachmentId)
    || !['created', 'retry', 'guest_created', 'human_detached'].includes(String(value.disposition))
    || !isRecord(value.deviceActor)
    || !hasExactKeys(value.deviceActor, ['kind', 'principal', 'connectionId'])
    || value.deviceActor.kind !== 'hub_device'
    || !isHubDevicePrincipalSnapshot(value.deviceActor.principal)
    || typeof value.deviceActor.connectionId !== 'string'
    || value.deviceActor.connectionId.length === 0
    || !isRecord(value.channel)
    || !hasExactKeys(value.channel, ['source', 'id', 'companionId'])
    || value.channel.source !== 'server'
    || typeof value.channel.id !== 'string'
    || !/^hub-device:[0-9a-f]{64}$/u.test(value.channel.id)
    || !isRfc4122Uuid(value.channel.companionId)
    || !isRecord(value.actor)) return false;

  if (value.actor.kind === 'guest') {
    return hasExactKeys(value.actor, ['kind', 'companionId'])
      && isRfc4122Uuid(value.actor.companionId);
  }
  if (value.actor.kind !== 'human'
    || !hasExactKeys(
      value.actor,
      ['kind', 'principalId', 'companionId', 'providerSubject', 'contact', 'operator', 'session'],
    )
    || !isRfc4122Uuid(value.actor.principalId)
    || !isRfc4122Uuid(value.actor.companionId)
    || !isRecord(value.actor.providerSubject)
    || !hasExactKeys(value.actor.providerSubject, ['provider', 'subjectId'])
    || value.actor.providerSubject.provider !== 'discord'
    || typeof value.actor.providerSubject.subjectId !== 'string'
    || !/^[1-9][0-9]{16,19}$/u.test(value.actor.providerSubject.subjectId)
    || !isRecord(value.actor.contact)
    || !hasExactKeys(value.actor.contact, ['bindingId', 'contactId', 'bindingVersion'])
    || !isRfc4122Uuid(value.actor.contact.bindingId)
    || typeof value.actor.contact.contactId !== 'string'
    || value.actor.contact.contactId.length === 0
    || !isPositiveInteger(value.actor.contact.bindingVersion)
    || !isRecord(value.actor.operator)
    || !hasExactKeys(value.actor.operator, ['grantId', 'role', 'grantVersion'])
    || !isRfc4122Uuid(value.actor.operator.grantId)
    || !['owner', 'admin', 'member', 'guest'].includes(String(value.actor.operator.role))
    || !isPositiveInteger(value.actor.operator.grantVersion)
    || !isRecord(value.actor.session)
    || !hasExactKeys(
      value.actor.session,
      ['recordId', 'authorityGeneration', 'globalAuthEpoch'],
    )
    || !isRfc4122Uuid(value.actor.session.recordId)
    || !isPositiveInteger(value.actor.session.authorityGeneration)
    || !isPositiveInteger(value.actor.session.globalAuthEpoch)) return false;
  return true;
}
