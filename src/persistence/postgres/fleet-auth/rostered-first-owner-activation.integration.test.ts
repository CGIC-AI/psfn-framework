import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_SESSION_TEST_NOW as NOW,
  OAUTH_SESSION_TEST_PROVIDER_SUBJECT_ID as PROVIDER_SUBJECT_ID,
  useOAuthSessionStoreIntegrationHarness,
} from './oauth-session-store.integration-harness.js';

const TIMEOUT_MS = 120_000;
const SECOND_PROVIDER_SUBJECT_ID = '223456789012345679';
const { createStore, authenticate } = useOAuthSessionStoreIntegrationHarness(
  'first_owner',
  TIMEOUT_MS,
);

describe('rostered first-owner activation', () => {
  it('materializes the complete first-owner authority during the first fresh-fleet login', async () => {
    const companionId = randomUUID();
    const secondCompanionId = randomUUID();
    const { store, runtime, coordinator, migration } = await createStore({
      accountRoster: [{
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        role: 'owner',
      }, {
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId: secondCompanionId,
        contactId: 'owner-contact-2',
        role: 'owner',
      }, {
        providerSubjectId: SECOND_PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'second-owner-contact',
        role: 'owner',
      }],
    });
    try {
      const loginInput = await authenticate(store, 'rostered-first-owner');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: { mfaEnabled: true },
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });

      expect(login.principalStatus).toBe('active');
      const authority = await runtime.query<{
        principal_status: string;
        provider_state: string;
        authn_version: string;
        authz_version: string;
        binding_version: string;
        grant_version: string;
        policy_version: string;
        global_auth_epoch: string;
        session_global_auth_epoch: string;
        bindings: string;
        grants: string;
        companion_authorities: string;
        activation_audits: string;
        login_reason: string;
      }>(`
        SELECT principal.status AS principal_status,
               subject.state AS provider_state,
               principal.authn_version::text,
               principal.authz_version::text,
               principal.binding_version::text,
               principal.grant_version::text,
               principal.policy_version::text,
               authority.global_auth_epoch::text,
               session.global_auth_epoch::text AS session_global_auth_epoch,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id
                  AND state = 'active' AND restore_state = 'live'
                  AND authority_generation = 1) AS bindings,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id
                  AND role = 'owner' AND lifecycle = 'active' AND restore_state = 'live'
                  AND authority_generation = 1) AS grants,
               (SELECT count(*)::text FROM fleet_auth.companion_authority_state
                WHERE companion_id IN ($4, $5)
                  AND lifecycle = 'active' AND restore_state = 'live'
                  AND authority_generation = 1) AS companion_authorities,
               (SELECT count(*)::text FROM fleet_auth.authorization_audit_events
                WHERE principal_id = principal.principal_id
                  AND action = 'authority.first_owner'
                  AND reason_code = 'account_roster_first_owner') AS activation_audits,
               (SELECT reason_code FROM fleet_auth.authorization_audit_events
                WHERE principal_id = principal.principal_id AND action = 'session.login'
                ORDER BY occurred_at DESC LIMIT 1) AS login_reason
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject
          ON subject.principal_id = principal.principal_id
         AND subject.provider = 'discord'
         AND subject.subject_id = $2
        JOIN fleet_auth.browser_sessions AS session ON session.record_id = $3
        JOIN fleet_auth.authority_state AS authority ON authority.singleton = TRUE
        WHERE principal.principal_id = $1
      `, [
        login.principalId,
        PROVIDER_SUBJECT_ID,
        login.recordId,
        companionId,
        secondCompanionId,
      ]);
      expect(authority.rows[0]).toEqual({
        principal_status: 'active',
        provider_state: 'active',
        authn_version: '2',
        authz_version: '2',
        binding_version: '2',
        grant_version: '2',
        policy_version: '2',
        global_auth_epoch: '1',
        session_global_auth_epoch: '1',
        bindings: '2',
        grants: '2',
        companion_authorities: '2',
        activation_audits: '1',
        login_reason: 'rostered_first_owner',
      });

      const secondLoginInput = await authenticate(store, 'rostered-second-owner');
      const secondLogin = await store.createLoginSession({
        ...secondLoginInput,
        providerSubjectId: SECOND_PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: new Date(NOW.getTime() + 1_000),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(secondLogin.principalStatus).toBe('pending');
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('defers to any pending first-owner ceremony in the fleet', async () => {
    const companionId = randomUUID();
    const { store, runtime, coordinator, migration } = await createStore({
      accountRoster: [{
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        role: 'owner',
      }],
    });
    try {
      await migration.query(`
        INSERT INTO fleet_auth.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider,
           expected_provider_subject_id, expected_companion_id,
           expected_contact_id, exact_scope, status, global_auth_epoch,
           created_at, expires_at)
        VALUES ($1, $2, 'first_owner', 'discord', $3, $4, 'other-owner-contact',
                '{"role":"owner"}'::jsonb, 'pending', 1,
                clock_timestamp(), clock_timestamp() + interval '5 minutes')
      `, [
        randomUUID(),
        'd'.repeat(64),
        SECOND_PROVIDER_SUBJECT_ID,
        companionId,
      ]);

      const loginInput = await authenticate(store, 'ceremony-precedence');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(login.principalStatus).toBe('pending');
      const materialized = await runtime.query<{
        bindings: string;
        grants: string;
        companion_authorities: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
           WHERE principal_id = $1) AS bindings,
          (SELECT count(*)::text FROM fleet_auth.principal_role_grants
           WHERE principal_id = $1) AS grants,
          (SELECT count(*)::text FROM fleet_auth.companion_authority_state
           WHERE companion_id = $2) AS companion_authorities
      `, [login.principalId, companionId]);
      expect(materialized.rows[0]).toEqual({
        bindings: '0',
        grants: '0',
        companion_authorities: '0',
      });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);
});
