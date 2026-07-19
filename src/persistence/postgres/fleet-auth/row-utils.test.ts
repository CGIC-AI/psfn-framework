import { describe, expect, it } from 'vitest';
import {
  positiveInteger,
  type FleetAuthSessionRow,
} from './row-utils.js';
import {
  mapAuthorizationContextSessionRow,
} from './authorization-context-store.js';
import {
  mapPortalAuthorizationSessionRow,
} from './portal-authorization-store.js';

const IDLE_EXPIRES_AT = new Date('2030-01-02T03:04:05.000Z');
const ABSOLUTE_EXPIRES_AT = new Date('2030-01-03T03:04:05.000Z');

const FULLY_POPULATED_ROW = {
  record_id: 'session-record',
  principal_id: 'principal-id',
  provider: 'discord',
  provider_subject_id: 'provider-subject-id',
  audience: 'fleet',
  assurance: 'webauthn_uv',
  session_authn_version: '1',
  session_authz_version: '2',
  binding_version: '3',
  grant_version: '4',
  policy_version: '5',
  session_global_auth_epoch: '6',
  idle_expires_at: IDLE_EXPIRES_AT,
  absolute_expires_at: ABSOLUTE_EXPIRES_AT,
  replaced_by: 'replacement-session',
  revoked_at: new Date('2030-01-01T03:04:05.000Z'),
  principal_status: 'active',
  principal_authn_version: '7',
  principal_authz_version: '8',
  principal_binding_version: '9',
  principal_grant_version: '10',
  principal_policy_version: '11',
  principal_authority_generation: '12',
  principal_restore_state: 'live',
  merged_into_principal_id: 'canonical-principal',
  principal_tombstoned: true,
} as const satisfies FleetAuthSessionRow;

const EXPECTED_SESSION = {
  recordId: 'session-record',
  principalId: 'principal-id',
  provider: 'discord',
  providerSubjectId: 'provider-subject-id',
  audience: 'fleet',
  assurance: 'webauthn_uv',
  authnVersion: 1,
  authzVersion: 2,
  bindingVersion: 3,
  grantVersion: 4,
  policyVersion: 5,
  globalAuthEpoch: 6,
  idleExpiresAt: IDLE_EXPIRES_AT,
  absoluteExpiresAt: ABSOLUTE_EXPIRES_AT,
  replacedBy: 'replacement-session',
  revokedAt: FULLY_POPULATED_ROW.revoked_at,
  principal: {
    status: 'active',
    authnVersion: 7,
    authzVersion: 8,
    bindingVersion: 9,
    grantVersion: 10,
    policyVersion: 11,
    authorityGeneration: 12,
    restoreState: 'live',
    mergedIntoPrincipalId: 'canonical-principal',
    tombstoned: true,
  },
};

describe('fleet-auth row utilities', () => {
  it('maps every session and principal field identically for both former store call sites', () => {
    expect(mapAuthorizationContextSessionRow(FULLY_POPULATED_ROW))
      .toEqual(EXPECTED_SESSION);
    expect(mapPortalAuthorizationSessionRow(FULLY_POPULATED_ROW))
      .toEqual(EXPECTED_SESSION);
  });

  it('preserves positive-integer failure and zero-handling behavior for every store scope', () => {
    expect(positiveInteger('3')).toBe(3);
    expect(positiveInteger('0')).toBeUndefined();
    expect(positiveInteger('not-a-number')).toBeUndefined();
    expect(positiveInteger('0', 'counter', 'jit-step-up', true)).toBe(0);

    expect(() => positiveInteger('0', 'version', 'authorization-context'))
      .toThrow('Invalid fleet_auth authorization context version');
    expect(() => positiveInteger('0', 'version', 'portal-authorization'))
      .toThrow('Invalid fleet portal authorization version');
    expect(() => positiveInteger('0', 'version', 'hub-device-attachment'))
      .toThrow('Invalid hub device attachment version');
    expect(() => positiveInteger('0', 'version', 'jit-step-up'))
      .toThrow('Invalid fleet_auth version');
    expect(() => positiveInteger('0', 'version', 'lifecycle-audit'))
      .toThrow('Invalid fleet_auth lifecycle audit version');
  });
});
