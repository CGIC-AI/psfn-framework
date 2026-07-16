import { isRecord } from '../utils/types.js';

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
