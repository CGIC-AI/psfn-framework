import type { PoolClient } from 'pg';
import type { FleetAuthSessionRecord } from '../../../boundary/gateway/fleet-auth-broker.js';

export interface SessionAuthorityRow {
  record_id: string;
  principal_id: string;
  principal_status: 'pending' | 'active' | 'suspended' | 'revoked' | 'quarantined';
  authn_version: string;
  authz_version: string;
  session_authn_version: string;
  session_authz_version: string;
  global_auth_epoch: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  restore_state: 'live' | 'quarantined';
}

export interface PrincipalRow {
  principal_id: string;
  status: 'pending' | 'active' | 'suspended' | 'revoked' | 'quarantined';
  authn_version: string;
  authz_version: string;
}

export type LockValidSession = (
  client: PoolClient,
  token: string,
  csrfToken: string,
  now: Date,
) => Promise<SessionAuthorityRow>;

export type InsertSession = (
  client: PoolClient,
  input: {
    principal: PrincipalRow;
    recordId?: string;
    audience: string;
    token: string;
    csrfToken: string;
    now: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    globalAuthEpoch: number;
  },
) => Promise<FleetAuthSessionRecord>;
