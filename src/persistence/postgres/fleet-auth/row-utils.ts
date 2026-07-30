import type { FleetAuthorizationSnapshot } from '../../../boundary/gateway/fleet-authorization-context.js';

export interface FleetAuthSessionRow {
  record_id: string;
  principal_id: string;
  provider: 'discord' | null;
  provider_subject_id: string | null;
  audience: string;
  assurance: 'oauth' | 'escalated' | 'break_glass';
  session_authn_version: string;
  session_authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  replaced_by: string | null;
  revoked_at: Date | null;
  principal_status: FleetAuthorizationSnapshot['sessions'][number]['principal']['status'];
  principal_authn_version: string;
  principal_authz_version: string;
  principal_binding_version: string;
  principal_grant_version: string;
  principal_policy_version: string;
  principal_authority_generation: string;
  principal_restore_state: 'live' | 'quarantined';
  merged_into_principal_id: string | null;
  principal_tombstoned: boolean;
}

export type PositiveIntegerScope =
  | 'authorization-context'
  | 'portal-authorization'
  | 'hub-device-attachment'
  | 'escalation-grant'
  | 'lifecycle-audit';

const ERROR_PREFIX_BY_SCOPE: Record<PositiveIntegerScope, string> = {
  'authorization-context': 'Invalid fleet_auth authorization context',
  'portal-authorization': 'Invalid fleet portal authorization',
  'hub-device-attachment': 'Invalid hub device attachment',
  'escalation-grant': 'Invalid fleet_auth',
  'lifecycle-audit': 'Invalid fleet_auth lifecycle audit',
};

export function positiveInteger(value: string): number | undefined;
export function positiveInteger(
  value: string,
  field: string,
  scope: PositiveIntegerScope,
  allowZero?: boolean,
): number;
export function positiveInteger(
  value: string,
  field?: string,
  scope?: PositiveIntegerScope,
  allowZero = false,
): number | undefined {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= (allowZero ? 0 : 1)) {
    return parsed;
  }
  if (field === undefined) return undefined;
  if (scope === undefined) {
    throw new Error('Invalid fleet_auth positive integer coercion context');
  }
  throw new Error(`${ERROR_PREFIX_BY_SCOPE[scope]} ${field}`);
}

export function createPositiveIntegerCoercer(
  scope: PositiveIntegerScope,
): (value: string, field: string, allowZero?: boolean) => number {
  return (value, field, allowZero = false) => positiveInteger(value, field, scope, allowZero);
}

export function mapFleetAuthSessionRow(
  row: FleetAuthSessionRow,
  scope: 'authorization-context' | 'portal-authorization',
): FleetAuthorizationSnapshot['sessions'][number] {
  return {
    recordId: row.record_id,
    principalId: row.principal_id,
    provider: row.provider,
    providerSubjectId: row.provider_subject_id,
    audience: row.audience,
    assurance: row.assurance,
    authnVersion: positiveInteger(row.session_authn_version, 'session.authn_version', scope),
    authzVersion: positiveInteger(row.session_authz_version, 'session.authz_version', scope),
    bindingVersion: positiveInteger(row.binding_version, 'session.binding_version', scope),
    grantVersion: positiveInteger(row.grant_version, 'session.grant_version', scope),
    policyVersion: positiveInteger(row.policy_version, 'session.policy_version', scope),
    globalAuthEpoch: positiveInteger(
      row.session_global_auth_epoch,
      'session.global_auth_epoch',
      scope,
    ),
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    replacedBy: row.replaced_by,
    revokedAt: row.revoked_at,
    principal: {
      status: row.principal_status,
      authnVersion: positiveInteger(row.principal_authn_version, 'principal.authn_version', scope),
      authzVersion: positiveInteger(row.principal_authz_version, 'principal.authz_version', scope),
      bindingVersion: positiveInteger(
        row.principal_binding_version,
        'principal.binding_version',
        scope,
      ),
      grantVersion: positiveInteger(
        row.principal_grant_version,
        'principal.grant_version',
        scope,
      ),
      policyVersion: positiveInteger(
        row.principal_policy_version,
        'principal.policy_version',
        scope,
      ),
      authorityGeneration: positiveInteger(
        row.principal_authority_generation,
        'principal.authority_generation',
        scope,
      ),
      restoreState: row.principal_restore_state,
      mergedIntoPrincipalId: row.merged_into_principal_id,
      tombstoned: row.principal_tombstoned,
    },
  };
}
