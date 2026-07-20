import { describe, expect, it, vi } from 'vitest';
import { PostgresChildAssertionAuthority } from './child-assertion-authority.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import type { ChildAssertionAuthorityInput } from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000201';
const PARENT_DECISION_ID = '00000000-0000-4000-8000-000000000202';
const SUBJECT = '100000000000000001';
const CHILD_ACTION = 'settings.write';

interface HarnessOptions {
  accountRoster?: FleetAuthConfig['accountRoster'];
  disabledOwnerActions?: string[];
  /** Row returned for the parent authorization audit lookup. */
  parentAudit?: Record<string, unknown> | null;
  /** Row returned for the exact current grant/count query. */
  currentGrant?: Record<string, unknown> | null;
  externalAuthorityCurrent?: boolean;
}

function parentAuditRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principal_id: PRINCIPAL_ID,
    action: 'garden.read',
    companion_id: COMPANION_ID,
    decision: 'allow',
    authority_generation: '5',
    global_auth_epoch: '9',
    ...overrides,
  };
}

function intactGrantRow(): Record<string, unknown> {
  return {
    role: 'owner',
    session_count: '1',
    provider_count: '1',
    binding_count: '1',
    grant_count: '1',
  };
}

function brokenGrantRow(): Record<string, unknown> {
  return {
    role: 'owner',
    session_count: '0',
    provider_count: '0',
    binding_count: '0',
    grant_count: '1',
  };
}

function versions(overrides: Record<string, number> = {}) {
  return {
    authorityGeneration: 5,
    globalAuthEpoch: 9,
    sessionAuthnVersion: 2,
    sessionAuthzVersion: 3,
    bindingVersion: 4,
    grantVersion: 5,
    policyVersion: 6,
    ...overrides,
  };
}

function input(overrides: {
  parentCompanionId?: string;
  childCompanionId?: string;
  providerSubjectId?: string;
  parentVersions?: Record<string, number>;
} = {}): ChildAssertionAuthorityInput {
  const parentCompanionId = overrides.parentCompanionId ?? COMPANION_ID;
  const childCompanionId = overrides.childCompanionId ?? COMPANION_ID;
  return {
    operator: {
      kind: 'operator_process',
      operatorId: `operator:${childCompanionId}`,
      companionId: childCompanionId,
    },
    parent: {
      decisionId: PARENT_DECISION_ID,
      action: 'garden.read',
      companionId: parentCompanionId,
      versions: versions(overrides.parentVersions ?? {}),
      targetDigest: 'a'.repeat(64),
      authContext: {
        provider: 'discord',
        providerSubjectId: overrides.providerSubjectId ?? SUBJECT,
      },
    },
    parentTarget: { companionId: parentCompanionId, targetDigest: 'a'.repeat(64) },
    childTarget: {
      companionId: childCompanionId,
      action: CHILD_ACTION,
      targetDigest: 'b'.repeat(64),
    },
  } as unknown as ChildAssertionAuthorityInput;
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<{ decision: unknown; reasonCode: unknown }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO')) {
        audits.push({ decision: params?.[4], reasonCode: params?.[5] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes(FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME)) {
        return { rows: [{ authority_generation: '5', global_auth_epoch: '9' }] };
      }
      if (sql.includes('grant_count')) {
        const row = options.currentGrant === null ? undefined : options.currentGrant;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('authorization_audit_events')) {
        const row = options.parentAudit === null ? undefined : options.parentAudit;
        return { rows: row ? [row] : [] };
      }
      // Companion authority lock: locking side effect only.
      return { rows: [{}], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  const authority = new PostgresChildAssertionAuthority(
    pool as never,
    {
      rolePolicy: {
        disabledActionsByRole: {
          owner: (options.disabledOwnerActions ?? []) as never,
          admin: [],
          member: [],
          guest: [],
        },
      },
      ...(options.accountRoster ? { accountRoster: options.accountRoster } : {}),
    },
    {
      sessionAuthorityGenerationIsCurrent: () => options.externalAuthorityCurrent ?? true,
      fence: async () => { throw new Error('not used'); },
    },
    () => new Date('2026-07-16T12:00:00.000Z'),
  );
  return { authority, audits };
}

const OWNER_ROSTER = [
  { providerSubjectId: SUBJECT, companionId: COMPANION_ID, role: 'owner' as const },
];

describe('postgres child assertion authority roster bypass', () => {
  it('keeps the intact non-roster gauntlet allowing with the exact reason code', async () => {
    const { authority, audits } = harness({
      parentAudit: parentAuditRow(),
      currentGrant: intactGrantRow(),
    });
    const decision = await authority.reauthorize(input());
    expect(decision.decision).toBe('allow');
    expect(audits).toEqual([
      { decision: 'allow', reasonCode: 'child_authority_reauthorized' },
    ]);
  });

  it('denies a non-rostered subject when the count invariants are broken', async () => {
    const { authority, audits } = harness({
      parentAudit: parentAuditRow(),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
    expect(audits).toEqual([
      { decision: 'deny', reasonCode: 'child_authority_denied' },
    ]);
  });

  it('passes a rostered subject without count invariants or generation exact-match', async () => {
    const { authority, audits } = harness({
      accountRoster: OWNER_ROSTER,
      parentAudit: parentAuditRow({ authority_generation: '2', global_auth_epoch: '3' }),
      currentGrant: brokenGrantRow(),
      externalAuthorityCurrent: false,
    });
    const decision = await authority.reauthorize(
      input({ parentVersions: { authorityGeneration: 2, globalAuthEpoch: 3 } }),
    );
    expect(decision.decision).toBe('allow');
    if (decision.decision !== 'allow') throw new Error('expected allow');
    expect(decision.versions).toEqual(versions({ authorityGeneration: 2, globalAuthEpoch: 3 }));
    expect(audits).toEqual([
      { decision: 'allow', reasonCode: 'child_authority_roster_reauthorized' },
    ]);
  });

  it('denies a rostered subject whose parent authorization decision is absent', async () => {
    const { authority, audits } = harness({
      accountRoster: OWNER_ROSTER,
      parentAudit: null,
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
    expect(audits).toEqual([
      { decision: 'deny', reasonCode: 'child_authority_denied' },
    ]);
  });

  it('denies a rostered subject whose parent decision was itself a deny', async () => {
    const { authority } = harness({
      accountRoster: OWNER_ROSTER,
      parentAudit: parentAuditRow({ decision: 'deny' }),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
  });

  it('denies a rostered subject whose parent decision bound a different action', async () => {
    const { authority } = harness({
      accountRoster: OWNER_ROSTER,
      parentAudit: parentAuditRow({ action: 'companion.read' }),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
  });

  it('never lets a roster entry for another companion authorize this child target', async () => {
    const { authority } = harness({
      accountRoster: [
        { providerSubjectId: SUBJECT, companionId: OTHER_COMPANION_ID, role: 'owner' },
      ],
      parentAudit: parentAuditRow(),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
  });

  it('never matches a roster entry for a different Discord subject', async () => {
    const { authority } = harness({
      accountRoster: [
        { providerSubjectId: '999999999999999999', companionId: COMPANION_ID, role: 'owner' },
      ],
      parentAudit: parentAuditRow(),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
  });

  it('keeps roster grants inside the closed role/action policy and owner-file disables', async () => {
    const disabled = harness({
      accountRoster: OWNER_ROSTER,
      disabledOwnerActions: [CHILD_ACTION],
      parentAudit: parentAuditRow(),
      currentGrant: brokenGrantRow(),
    });
    expect(await disabled.authority.reauthorize(input())).toEqual({ decision: 'deny' });

    const guestRoster = harness({
      accountRoster: [
        { providerSubjectId: SUBJECT, companionId: COMPANION_ID, role: 'guest' },
      ],
      parentAudit: parentAuditRow(),
      currentGrant: brokenGrantRow(),
    });
    expect(await guestRoster.authority.reauthorize(input())).toEqual({ decision: 'deny' });
  });

  it('denies when parent and child companion scopes diverge even for a rostered subject', async () => {
    const { authority } = harness({
      accountRoster: OWNER_ROSTER,
      parentAudit: parentAuditRow({ companion_id: OTHER_COMPANION_ID }),
      currentGrant: brokenGrantRow(),
    });
    expect(await authority.reauthorize(
      input({ parentCompanionId: OTHER_COMPANION_ID }),
    )).toEqual({ decision: 'deny' });
  });

  it('still denies a stale-generation non-rostered subject with intact counts', async () => {
    const { authority, audits } = harness({
      parentAudit: parentAuditRow(),
      currentGrant: intactGrantRow(),
      externalAuthorityCurrent: false,
    });
    expect(await authority.reauthorize(input())).toEqual({ decision: 'deny' });
    expect(audits).toEqual([
      { decision: 'deny', reasonCode: 'child_authority_denied' },
    ]);
  });
});
