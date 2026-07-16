import { describe, expect, it } from 'vitest';
import type { FleetAuthAction, FleetAuthRole } from '../../system/config/fleet-auth-config.js';
import {
  evaluateFleetAuthorizationSnapshot,
  parseFleetAuthorizationRequest,
  type FleetAuthorizationSnapshot,
} from './fleet-authorization-context.js';

const PRINCIPAL_ID = '05a5ea76-075b-4c3c-9555-a87b9e0052e5';
const SESSION_ID = '61dd3958-12ae-494a-87ba-b3cd91975e44';
const COMPANION_ID = '7f87ee85-9fcc-4520-91a8-b728293eca76';
const OTHER_COMPANION_ID = '59b00741-2f3e-4f45-b359-9d95fe84bad0';
const BINDING_ID = 'cafb217b-89c2-42c6-85fa-b975fb1fe421';
const OTHER_BINDING_ID = '6fd8ea54-6b24-4fa5-8a58-5c1f99c16340';
const GRANT_ID = 'cf9c9b38-017b-4f60-a8a0-ee6e073f8b42';
const SUBJECT_ID = '123456789012345678';
const NOW = new Date('2026-07-16T12:00:00.000Z');

function snapshot(overrides: Partial<FleetAuthorizationSnapshot> = {}): FleetAuthorizationSnapshot {
  return {
    authority: { authorityGeneration: 4, globalAuthEpoch: 9 },
    sessions: [{
      recordId: SESSION_ID,
      principalId: PRINCIPAL_ID,
      audience: 'fleet',
      assurance: 'oauth',
      authnVersion: 3,
      authzVersion: 6,
      bindingVersion: 2,
      policyVersion: 5,
      globalAuthEpoch: 9,
      idleExpiresAt: new Date('2026-07-16T12:05:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-16T13:00:00.000Z'),
      replacedBy: null,
      revokedAt: null,
      principal: {
        status: 'active',
        authnVersion: 3,
        authzVersion: 6,
        authorityGeneration: 4,
        restoreState: 'live',
      },
    }],
    providerSubjects: [{
      provider: 'discord',
      subjectId: SUBJECT_ID,
      state: 'active',
      authorityGeneration: 4,
      restoreState: 'live',
      tombstoned: false,
    }],
    bindings: [{
      bindingId: BINDING_ID,
      companionId: COMPANION_ID,
      contactId: 'contact/shared-id',
      state: 'active',
      version: 2,
      authorityGeneration: 4,
      restoreState: 'live',
    }],
    grants: [{
      grantId: GRANT_ID,
      companionId: COMPANION_ID,
      role: 'member',
      lifecycle: 'active',
      version: 5,
      authorityGeneration: 4,
      restoreState: 'live',
    }],
    evidence: undefined,
    ...overrides,
  };
}

function decide(
  candidate = snapshot(),
  action: FleetAuthAction = 'memory.read.self',
) {
  return evaluateFleetAuthorizationSnapshot({
    request: {
      sessionToken: 'A'.repeat(43),
      audience: 'fleet',
      companionId: COMPANION_ID,
      action,
    },
    snapshot: candidate,
    disabledActionsByRole: {
      owner: [],
      admin: ['roles.manage'],
      member: ['settings.write', 'roles.manage'],
      guest: ['garden.read', 'settings.read', 'settings.write', 'roles.manage'],
    },
    now: NOW,
  });
}

function sessionWithPrincipal(
  overrides: Partial<FleetAuthorizationSnapshot['sessions'][number]['principal']>,
): FleetAuthorizationSnapshot['sessions'][number] {
  const current = snapshot().sessions.at(0);
  if (!current) throw new Error('authorization test fixture session is missing');
  return { ...current, principal: { ...current.principal, ...overrides } };
}

describe('fleet authorization context policy', () => {
  it('returns immutable, companion-local facts while keeping contact and operator authority separate', () => {
    const decision = decide();
    expect(decision).toMatchObject({
      decision: 'allow',
      facts: {
        principalId: PRINCIPAL_ID,
        providerSubjectId: SUBJECT_ID,
        companionId: COMPANION_ID,
        contact: { contactId: 'contact/shared-id', bindingId: BINDING_ID, bindingVersion: 2 },
        operator: { role: 'member', grantId: GRANT_ID, grantVersion: 5 },
        session: { recordId: SESSION_ID, authnVersion: 3, authzVersion: 6 },
        authority: { authorityGeneration: 4, globalAuthEpoch: 9 },
      },
    });
    if (decision.decision !== 'allow') throw new Error('expected allow');
    expect(decision.facts.contact).not.toHaveProperty('role');
    expect(decision.facts.operator).not.toHaveProperty('contactId');
    expect(decision.facts).not.toHaveProperty('trustLevel');
  });

  it.each([
    ['absent session', snapshot({ sessions: [] }), 'session_absent'],
    ['multiple sessions', snapshot({ sessions: [...snapshot().sessions, ...snapshot().sessions] }), 'session_ambiguous'],
    ['wrong stored audience', snapshot({ sessions: [{ ...snapshot().sessions[0]!, audience: 'garden' }] }), 'wrong_audience'],
    ['revoked session', snapshot({ sessions: [{ ...snapshot().sessions[0]!, revokedAt: NOW }] }), 'session_revoked'],
    ['stale authn', snapshot({ sessions: [{ ...snapshot().sessions[0]!, authnVersion: 2 }] }), 'session_authn_stale'],
    ['stale authz', snapshot({ sessions: [{ ...snapshot().sessions[0]!, authzVersion: 5 }] }), 'session_authz_stale'],
    ['stale epoch', snapshot({ sessions: [{ ...snapshot().sessions[0]!, globalAuthEpoch: 8 }] }), 'session_epoch_stale'],
    ['pending principal', snapshot({ sessions: [sessionWithPrincipal({ status: 'pending' })] }), 'principal_not_active'],
    ['restored principal', snapshot({ sessions: [sessionWithPrincipal({ restoreState: 'quarantined' })] }), 'principal_not_live'],
    ['absent provider', snapshot({ providerSubjects: [] }), 'provider_subject_absent'],
    ['multiple providers', snapshot({ providerSubjects: [...snapshot().providerSubjects, { ...snapshot().providerSubjects[0]!, subjectId: '123456789012345679' }] }), 'provider_subject_ambiguous'],
    ['suspended provider', snapshot({ providerSubjects: [{ ...snapshot().providerSubjects[0]!, state: 'suspended' }] }), 'provider_subject_not_active'],
    ['tombstoned provider', snapshot({ providerSubjects: [{ ...snapshot().providerSubjects[0]!, tombstoned: true }] }), 'provider_subject_tombstoned'],
    ['absent binding', snapshot({ bindings: [] }), 'binding_absent'],
    ['multiple bindings', snapshot({ bindings: [...snapshot().bindings, { ...snapshot().bindings[0]!, bindingId: OTHER_BINDING_ID, contactId: 'contact/other' }] }), 'binding_ambiguous'],
    ['conflicted binding', snapshot({ bindings: [{ ...snapshot().bindings[0]!, state: 'conflict' }] }), 'binding_not_active'],
    ['stale binding version', snapshot({ bindings: [{ ...snapshot().bindings[0]!, version: 3 }] }), 'binding_version_stale'],
    ['absent role', snapshot({ grants: [] }), 'role_absent'],
    ['suspended role', snapshot({ grants: [{ ...snapshot().grants[0]!, lifecycle: 'suspended' }] }), 'role_not_active'],
    ['stale policy version', snapshot({ grants: [{ ...snapshot().grants[0]!, version: 6 }] }), 'policy_version_stale'],
    ['stale authority generation', snapshot({ grants: [{ ...snapshot().grants[0]!, authorityGeneration: 3 }] }), 'authority_generation_stale'],
  ])('denies %s', (_label, candidate, reasonCode) => {
    expect(decide(candidate)).toEqual({ decision: 'deny', reasonCode });
  });

  it('keeps same contact identifiers companion-local and denies cross-companion requests', () => {
    const sameContactElsewhere = {
      ...snapshot().bindings[0]!,
      bindingId: OTHER_BINDING_ID,
      companionId: OTHER_COMPANION_ID,
    };
    expect(decide(snapshot({ bindings: [snapshot().bindings[0]!, sameContactElsewhere] })))
      .toMatchObject({ decision: 'allow' });
    expect(evaluateFleetAuthorizationSnapshot({
      request: {
        sessionToken: 'A'.repeat(43),
        audience: 'fleet',
        companionId: OTHER_COMPANION_ID,
        action: 'memory.read.self',
      },
      snapshot: snapshot({ bindings: [snapshot().bindings[0]!, sameContactElsewhere] }),
      disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
      now: NOW,
    })).toEqual({ decision: 'deny', reasonCode: 'role_absent' });
  });

  it.each([
    ['owner', 'roles.manage', true],
    ['admin', 'roles.manage', false],
    ['member', 'memory.read.self', true],
    ['member', 'provider.link', false],
    ['guest', 'companion.read', true],
    ['guest', 'memory.read.self', false],
  ] as Array<[FleetAuthRole, FleetAuthAction, boolean]>)('%s action %s is %s', (role, action, allowed) => {
    const candidate = snapshot({ grants: [{ ...snapshot().grants[0]!, role }] });
    expect(decide(candidate, action).decision === 'allow').toBe(allowed);
  });

  it('treats optional Discord evidence only as a narrowing prerequisite', () => {
    const evidence = {
      evidenceId: '64a1d054-22dd-4e76-9bb3-3ac0d33c63c5',
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      companionId: COMPANION_ID,
      guildId: '223456789012345678',
      channelId: '323456789012345678',
      threadId: null,
      inputDigest: 'a'.repeat(64),
      configDigest: 'b'.repeat(64),
      mappingConfigVersion: 2,
      globalAuthEpoch: 9,
      psfnEvidenceResult: true,
      discordPermissionResult: true,
      memberSpecificDenyVeto: false,
      decisionReason: null,
      lifecycleState: 'active',
      lifecycleGlobalAuthEpoch: 9,
      expiresAt: new Date('2026-07-16T12:01:00.000Z'),
      integrityValid: true,
      configCurrent: true,
    } as const;
    expect(decide(snapshot({ evidence }))).toMatchObject({ decision: 'allow' });
    expect(decide(snapshot({ evidence: { ...evidence, companionId: OTHER_COMPANION_ID } })))
      .toEqual({ decision: 'deny', reasonCode: 'evidence_misbound' });
    expect(decide(snapshot({ evidence: { ...evidence, memberSpecificDenyVeto: true } })))
      .toEqual({ decision: 'deny', reasonCode: 'evidence_not_positive' });
  });
});

describe('fleet authorization request parsing', () => {
  const valid = {
    sessionToken: 'A'.repeat(43),
    audience: 'fleet',
    companionId: COMPANION_ID,
    action: 'memory.read.self',
    discordEvidence: { evidenceId: '64a1d054-22dd-4e76-9bb3-3ac0d33c63c5' },
    correlationId: 'request-123',
  };

  it('accepts only the bounded request contract', () => {
    expect(parseFleetAuthorizationRequest(valid, new Set([COMPANION_ID])))
      .toMatchObject({ ok: true, request: valid });
  });

  it.each([
    [{ ...valid, audience: 'garden' }, 'wrong_audience'],
    [{ ...valid, action: 'unknown.action' }, 'unknown_action'],
    [{ ...valid, companionId: OTHER_COMPANION_ID }, 'unknown_companion'],
    [{ ...valid, principalId: PRINCIPAL_ID }, 'malformed_request'],
    [{ ...valid, role: 'owner' }, 'malformed_request'],
    [{ ...valid, trustLevel: 'ultimate' }, 'malformed_request'],
    [{ ...valid, discordEvidence: { ...valid.discordEvidence, requiredRoleIds: [] } }, 'malformed_request'],
  ])('rejects spoofing or evidence widening', (input, reasonCode) => {
    expect(parseFleetAuthorizationRequest(input, new Set([COMPANION_ID])))
      .toMatchObject({ ok: false, reasonCode });
  });
});
