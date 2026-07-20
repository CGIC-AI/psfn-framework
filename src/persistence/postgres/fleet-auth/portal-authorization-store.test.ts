import { describe, expect, it, vi } from 'vitest';
import { PostgresFleetPortalAuthorizationStore } from './portal-authorization-store.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000301';
const SESSION_ID = '00000000-0000-4000-8000-000000000302';
const SUBJECT = '100000000000000001';
const NOW = new Date('2026-07-16T12:00:00.000Z');
const TOKEN = 'A'.repeat(43);

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: SESSION_ID,
    principal_id: PRINCIPAL_ID,
    provider: 'discord',
    provider_subject_id: SUBJECT,
    audience: 'fleet',
    assurance: 'oauth',
    session_authn_version: '2',
    session_authz_version: '3',
    binding_version: '4',
    grant_version: '5',
    policy_version: '6',
    session_global_auth_epoch: '9',
    idle_expires_at: new Date('2026-07-16T12:05:00.000Z'),
    absolute_expires_at: new Date('2026-07-16T13:00:00.000Z'),
    replaced_by: null,
    revoked_at: null,
    principal_status: 'active',
    principal_authn_version: '2',
    principal_authz_version: '3',
    principal_binding_version: '4',
    principal_grant_version: '5',
    principal_policy_version: '6',
    principal_authority_generation: '5',
    principal_restore_state: 'live',
    merged_into_principal_id: null,
    principal_tombstoned: false,
    ...overrides,
  };
}

function companionRow(companionId: string): Record<string, unknown> {
  return {
    companion_id: companionId,
    lifecycle: 'active',
    version: '1',
    authority_generation: '5',
    restore_state: 'live',
    authority_lineage_id: null,
    lineage_floor_current: false,
    tombstoned: false,
  };
}

function config(accountRoster?: FleetAuthConfig['accountRoster']): FleetAuthConfig {
  return {
    rolePolicy: {
      disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
    },
    ...(accountRoster ? { accountRoster } : {}),
  } as unknown as FleetAuthConfig;
}

function subjectRow(companionId: string): Record<string, unknown> {
  return {
    companion_id: companionId,
    provider: 'discord',
    subject_id: SUBJECT,
    state: 'active',
    authority_generation: '5',
    restore_state: 'live',
    tombstoned: false,
    contact_authority_fenced: false,
  };
}

function harness(options: {
  accountRoster?: FleetAuthConfig['accountRoster'];
  sessionRows?: Array<Record<string, unknown>>;
  generationCurrent?: boolean;
  generationCurrentSequence?: readonly boolean[];
} = {}) {
  const audits: Array<{ decision: unknown; reasonCode: unknown }> = [];
  const generationCurrentSequence = [...(options.generationCurrentSequence ?? [])];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO')) {
        audits.push({ decision: params?.[2], reasonCode: params?.[3] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes(FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME)) {
        return { rows: [{ authority_generation: '5', global_auth_epoch: '9' }] };
      }
      if (sql.includes('provider_subjects AS subject')) {
        return { rows: [subjectRow(COMPANION_A), subjectRow(COMPANION_B)] };
      }
      if (sql.includes('principal_contact_bindings')) return { rows: [] };
      if (sql.includes('principal_role_grants')) return { rows: [] };
      if (sql.includes('browser_sessions')) {
        return { rows: options.sessionRows ?? [sessionRow()] };
      }
      // Companion authority lock over the requested companion set.
      return { rows: [companionRow(COMPANION_A), companionRow(COMPANION_B)] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  const store = new PostgresFleetPortalAuthorizationStore({
    pool: pool as never,
    sessionPepper: 'p'.repeat(32),
    config: config(options.accountRoster),
    knownCompanionIds: [COMPANION_A, COMPANION_B],
    providerRevocationAuthority: {
      sessionAuthorityGenerationIsCurrent: () => (
        generationCurrentSequence.shift() ?? options.generationCurrent ?? true
      ),
      fence: async () => { throw new Error('not used'); },
    },
    now: () => NOW,
  });
  return { store, audits };
}

const OWNER_ROSTER = [
  { providerSubjectId: SUBJECT, companionId: COMPANION_A, role: 'owner' as const },
];

describe('postgres fleet portal authorization roster fallback', () => {
  it('refuses startup when the roster names a companion outside the known fleet', () => {
    expect(() => harness({
      accountRoster: [{
        providerSubjectId: SUBJECT,
        companionId: '33333333-3333-4333-8333-333333333333',
        role: 'owner',
      }],
    })).toThrow(/accountRoster references unknown companion/);
  });

  it('resolves only the rostered companions for a quarantined-principal session', async () => {
    const { store, audits } = harness({
      accountRoster: OWNER_ROSTER,
      sessionRows: [sessionRow({
        principal_status: 'quarantined',
        principal_restore_state: 'quarantined',
      })],
    });
    const decision = await store.resolveBatch({ sessionToken: TOKEN });
    expect(decision).toEqual({
      decision: 'allow',
      companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
    });
    expect(audits).toEqual([
      { decision: 'allow', reasonCode: 'roster_portal_projection_allowed' },
    ]);
  });

  it('keeps the identical denial for the same broken session without a roster match', async () => {
    const brokenSession = [sessionRow({
      principal_status: 'quarantined',
      principal_restore_state: 'quarantined',
    })];
    const noRoster = harness({ sessionRows: brokenSession });
    expect(await noRoster.store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'deny',
      reasonCode: 'principal_not_active',
    });

    const foreignRoster = harness({
      accountRoster: [
        { providerSubjectId: '999999999999999999', companionId: COMPANION_A, role: 'owner' },
      ],
      sessionRows: brokenSession,
    });
    expect(await foreignRoster.store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'deny',
      reasonCode: 'principal_not_active',
    });
  });

  it('resolves rostered companions across a stale authority generation', async () => {
    const stale = harness({ accountRoster: OWNER_ROSTER, generationCurrent: false });
    expect(await stale.store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'allow',
      companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
    });

    const noRoster = harness({ generationCurrent: false });
    expect(await noRoster.store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'deny',
      reasonCode: 'authority_generation_stale',
    });
  });

  it('denies a rostered subject outright when its session is revoked', async () => {
    const { store } = harness({
      accountRoster: OWNER_ROSTER,
      sessionRows: [sessionRow({ revoked_at: NOW })],
    });
    expect(await store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'deny',
      reasonCode: 'session_revoked',
    });
  });

  it('denies an absent session even with a configured roster', async () => {
    const { store } = harness({ accountRoster: OWNER_ROSTER, sessionRows: [] });
    expect(await store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'deny',
      reasonCode: 'session_absent',
    });
  });

  it('includes rostered companions in the healthy full-path projection', async () => {
    const { store, audits } = harness({ accountRoster: OWNER_ROSTER });
    const decision = await store.resolveBatch({ sessionToken: TOKEN });
    expect(decision).toEqual({
      decision: 'allow',
      companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
    });
    expect(audits).toEqual([
      { decision: 'allow', reasonCode: 'portal_projection_allowed' },
    ]);
  });

  it('audits a post-commit degradation from the full projection to roster-only', async () => {
    const { store, audits } = harness({
      accountRoster: OWNER_ROSTER,
      generationCurrentSequence: [true, false],
    });
    expect(await store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'allow',
      companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
    });
    expect(audits).toEqual([
      { decision: 'allow', reasonCode: 'portal_projection_allowed' },
      {
        decision: 'allow',
        reasonCode: 'roster_portal_projection_post_commit_degraded',
      },
    ]);
  });

  it('projects an empty healthy batch without a roster instead of widening', async () => {
    const { store } = harness();
    expect(await store.resolveBatch({ sessionToken: TOKEN })).toEqual({
      decision: 'allow',
      companions: [],
    });
  });
});
