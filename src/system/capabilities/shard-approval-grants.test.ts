import { describe, expect, it } from 'vitest';
import { ConfirmationQueue } from './confirmation-queue.js';
import { CAPABILITY_TOKENS } from './tokens.js';
import {
  deriveShardCapabilityGrant,
  SHARD_CAPABILITY_DENIAL_MASK,
} from './shard-derivation.js';
import {
  assertShardTemporaryGrantDisposition,
  ShardApprovalGrantAuthority,
  type AuthenticatedShardWorkloadHandle,
  type AuthenticatedShardWorkloadRegistration,
  type AuthenticatedShardWorkloadRegistry,
  type PreparedShardRequestGrant,
  type ShardApprovalGrantSnapshot,
} from './shard-approval-grants.js';

const PARENT_ID = 'companion-parent-test';
const METHOD = 'home_assistant.call_service';
const ACTION = 'home_assistant.control';
const SCOPE = 'site:test-zone/device:test-switch';

class TestWorkloadRegistry implements AuthenticatedShardWorkloadRegistry {
  private readonly records =
    new WeakMap<AuthenticatedShardWorkloadHandle, AuthenticatedShardWorkloadRegistration>();
  private readonly currentByShard = new Map<string, AuthenticatedShardWorkloadHandle>();

  register(input: AuthenticatedShardWorkloadRegistration): AuthenticatedShardWorkloadHandle {
    const handle = Object.freeze({
      kind: 'authenticated-shard-workload' as const,
    }) as AuthenticatedShardWorkloadHandle;
    this.records.set(handle, input);
    this.currentByShard.set(`${input.parentCompanionId}\0${input.shardId}`, handle);
    return handle;
  }

  end(handle: AuthenticatedShardWorkloadHandle): void {
    const record = this.records.get(handle);
    if (!record) return;
    const key = `${record.parentCompanionId}\0${record.shardId}`;
    if (this.currentByShard.get(key) === handle) {
      this.currentByShard.delete(key);
    }
  }

  resolveAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadRegistration | undefined {
    const record = this.records.get(handle);
    if (!record) return undefined;
    const key = `${record.parentCompanionId}\0${record.shardId}`;
    return this.currentByShard.get(key) === handle ? record : undefined;
  }
}

function registerWorkload(
  registry: TestWorkloadRegistry,
  input: {
    parentCompanionId?: string;
    shardId?: string;
    workloadGeneration?: string;
  } = {},
) {
  const standingGrant = deriveShardCapabilityGrant({
    companionId: PARENT_ID,
    tier: 'custom',
    customTokens: [...CAPABILITY_TOKENS],
  });
  const workload = registry.register({
    parentCompanionId: input.parentCompanionId ?? PARENT_ID,
    shardId: input.shardId ?? 'shard-instance-a',
    workloadGeneration: input.workloadGeneration ?? 'generation-1',
    shardLabel: 'Test Shard',
    capabilityGrant: standingGrant,
  });
  return { standingGrant, workload };
}

function requestTuple(workload: AuthenticatedShardWorkloadHandle) {
  return {
    workload,
    method: METHOD,
    action: ACTION,
    scope: SCOPE,
    params: { command: 'toggle' },
  } as const;
}

async function activateThroughApprovalQueue(input: {
  authority: ShardApprovalGrantAuthority;
  prepared: PreparedShardRequestGrant;
  approvalId: string;
  expiresAt: number;
  now: () => number;
  resolverId?: string;
  alreadyBound?: boolean;
}): Promise<ShardApprovalGrantSnapshot> {
  let activated: ShardApprovalGrantSnapshot | undefined;
  const queue = new ConfirmationQueue({
    now: input.now,
    idFactory: () => input.approvalId,
  });
  const entry = queue.enqueue({
    method: METHOD,
    action: ACTION,
    scope: SCOPE,
    params: { command: 'toggle' },
    companionReason: 'Test exceptional action',
    resolutionAuthority: 'operator',
    expiresInMs: input.expiresAt - input.now(),
  }, async (_params, _entry, context) => {
    activated = input.authority.activateRequestGrant(input.prepared, context);
  });
  if (!input.alreadyBound) {
    input.authority.bindRequestGrant(input.prepared, {
      approvalId: entry.id,
      expiresAt: entry.expiresAt,
    });
  }
  const result = await queue.resolve(
    { id: entry.id, decision: 'approve' },
    { kind: 'operator', id: input.resolverId ?? 'test-operator' },
  );
  expect(result).toMatchObject({ status: 'approved', executed: true });
  if (!activated) {
    throw new Error('Test approval executor did not activate a grant');
  }
  return activated;
}

describe('ShardApprovalGrantAuthority', () => {
  it('consumes the shared disposition table for all six masked tokens without widening standing access', () => {
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({ workloadRegistry: registry });
    const { standingGrant, workload } = registerWorkload(registry);
    const originalTokens = [...standingGrant.access.getGrantedTokens()];

    for (const token of SHARD_CAPABILITY_DENIAL_MASK) {
      if (token === 'world.control') {
        expect(() => assertShardTemporaryGrantDisposition(token, 'request')).not.toThrow();
        expect(() => authority.offerTtlGrant(token)).toThrow(/canonical TTL policy is unavailable/);
      } else {
        expect(() => assertShardTemporaryGrantDisposition(token, 'request'))
          .toThrow(/not eligible for a shard request grant/);
        expect(() => authority.offerTtlGrant(token))
          .toThrow(/not eligible for a shard TTL grant/);
      }
    }
    expect(() => authority.prepareRequestGrant(requestTuple(workload))).not.toThrow();
    expect(standingGrant.access.getTier()).toBe('custom');
    expect([...standingGrant.access.getGrantedTokens()]).toEqual(originalTokens);
    for (const token of SHARD_CAPABILITY_DENIAL_MASK) {
      expect(standingGrant.access.has(token)).toBe(false);
    }
  });

  it('rejects capability substitution and a registry record whose launch grant belongs to another parent', () => {
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({ workloadRegistry: registry });
    const { workload } = registerWorkload(registry);
    expect(() => authority.prepareRequestGrant({
      ...requestTuple(workload),
      method: 'memory.delete',
      action: 'delete',
    })).toThrow(/not an eligible shard exceptional action/);

    const mismatched = registerWorkload(registry, {
      parentCompanionId: 'companion-different-parent',
      shardId: 'shard-invalid-parent',
    }).workload;
    expect(() => authority.resolveAuthenticatedWorkload(mismatched))
      .toThrow(/grant parent does not match/);
  });

  it('requires a live queue approval proof and consumes the exact request once', async () => {
    let now = 1_000;
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => now,
      grantIdFactory: () => 'request-grant-1',
    });
    const { workload } = registerWorkload(registry);
    const tuple = requestTuple(workload);
    const prepared = authority.prepareRequestGrant(tuple);
    authority.bindRequestGrant(prepared, { approvalId: 'approval-1', expiresAt: 2_000 });
    expect(() => authority.activateRequestGrant(prepared, {
      resolver: { kind: 'operator', id: 'fabricated' },
    })).toThrow(/not backed by the resolved approval/);

    const grant = await activateThroughApprovalQueue({
      authority,
      prepared,
      approvalId: 'approval-1',
      expiresAt: 2_000,
      now: () => now,
      alreadyBound: true,
    });
    expect(grant).toMatchObject({
      grantId: 'request-grant-1',
      approvalId: 'approval-1',
      status: 'active',
      token: 'world.control',
      parentCompanionId: PARENT_ID,
      shardId: 'shard-instance-a',
      workloadGeneration: 'generation-1',
    });

    now = 1_100;
    expect(authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toMatchObject({ status: 'consumed', consumedAt: 1_100 });
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toThrow(/already consumed/);
  });

  it('denies approval, method, scope, params, sibling, parent, replacement, and expiry changes', async () => {
    let now = 2_000;
    let sequence = 0;
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => now,
      grantIdFactory: () => `request-grant-${++sequence}`,
    });
    const { workload } = registerWorkload(registry);
    const { workload: sibling } = registerWorkload(registry, { shardId: 'shard-instance-b' });
    const tuple = requestTuple(workload);
    const issue = async (approvalId: string, expiresAt = 3_000) => {
      const prepared = authority.prepareRequestGrant(tuple);
      return activateThroughApprovalQueue({
        authority,
        prepared,
        approvalId,
        expiresAt,
        now: () => now,
      });
    };

    const changedApproval = await issue('approval-changed');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: changedApproval.grantId,
      approvalId: 'approval-spoofed',
    })).toThrow(/does not match/);

    const changedMethod = await issue('approval-method');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      method: 'memory.delete',
      action: 'delete',
      grantId: changedMethod.grantId,
      approvalId: changedMethod.approvalId,
    })).toThrow(/not an eligible shard exceptional action/);

    const changedScope = await issue('approval-scope');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      scope: 'site:test-zone',
      grantId: changedScope.grantId,
      approvalId: changedScope.approvalId,
    })).toThrow(/does not match/);

    const changedParams = await issue('approval-params');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      params: { command: 'unlock' },
      grantId: changedParams.grantId,
      approvalId: changedParams.approvalId,
    })).toThrow(/does not match/);

    const siblingUse = await issue('approval-sibling');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      workload: sibling,
      grantId: siblingUse.grantId,
      approvalId: siblingUse.approvalId,
    })).toThrow(/does not match/);

    const parentUse = await issue('approval-parent');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      workload: { kind: 'authenticated-shard-workload' } as typeof workload,
      grantId: parentUse.grantId,
      approvalId: parentUse.approvalId,
    })).toThrow(/missing, replaced, or revoked/);

    const replaced = await issue('approval-replaced');
    registerWorkload(registry, { workloadGeneration: 'generation-2' });
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: replaced.grantId,
      approvalId: replaced.approvalId,
    })).toThrow(/missing, replaced, or revoked/);

    const { workload: expiringWorkload } = registerWorkload(registry, {
      shardId: 'shard-instance-expiring',
    });
    const expiringTuple = requestTuple(expiringWorkload);
    const prepared = authority.prepareRequestGrant(expiringTuple);
    const expiring = await activateThroughApprovalQueue({
      authority,
      prepared,
      approvalId: 'approval-expiring',
      expiresAt: 2_100,
      now: () => now,
    });
    now = 2_100;
    expect(() => authority.consumeRequestGrant({
      ...expiringTuple,
      grantId: expiring.grantId,
      approvalId: expiring.approvalId,
    })).toThrow(/expired/);
  });

  it('denies revocation, ended workloads, restart state loss, and clock uncertainty', async () => {
    let now = 5_000;
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => now,
      grantIdFactory: () => 'request-grant-revoked',
    });
    const { workload } = registerWorkload(registry);
    const tuple = requestTuple(workload);
    const grant = await activateThroughApprovalQueue({
      authority,
      prepared: authority.prepareRequestGrant(tuple),
      approvalId: 'approval-revoked',
      expiresAt: 6_000,
      now: () => now,
    });
    expect(authority.revokeGrant(grant.grantId)).toMatchObject({
      status: 'revoked',
      revokedAt: 5_000,
    });
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toThrow(/revoked/);

    const endedRegistry = new TestWorkloadRegistry();
    const endedAuthority = new ShardApprovalGrantAuthority({
      workloadRegistry: endedRegistry,
      now: () => now,
      grantIdFactory: () => 'request-grant-ended',
    });
    const { workload: ended } = registerWorkload(endedRegistry);
    const endedTuple = requestTuple(ended);
    const endedGrant = await activateThroughApprovalQueue({
      authority: endedAuthority,
      prepared: endedAuthority.prepareRequestGrant(endedTuple),
      approvalId: 'approval-ended',
      expiresAt: 6_000,
      now: () => now,
    });
    endedRegistry.end(ended);
    expect(() => endedAuthority.consumeRequestGrant({
      ...endedTuple,
      grantId: endedGrant.grantId,
      approvalId: endedGrant.approvalId,
    })).toThrow(/missing, replaced, or revoked/);

    const restarted = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => now,
    });
    expect(() => restarted.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toThrow(/missing/);

    now = 4_999;
    expect(() => authority.prepareRequestGrant(tuple)).toThrow(/clock is uncertain/);
    now = 5_001;
    expect(() => authority.prepareRequestGrant(tuple)).toThrow(/clock is uncertain/);
  });

  it('revokes active authority locally without mutating the authenticated registry record', async () => {
    let now = 7_000;
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => now,
      grantIdFactory: () => 'request-grant-workload-revoked',
    });
    const { workload } = registerWorkload(registry);
    const tuple = requestTuple(workload);
    const grant = await activateThroughApprovalQueue({
      authority,
      prepared: authority.prepareRequestGrant(tuple),
      approvalId: 'approval-workload-revoked',
      expiresAt: 8_000,
      now: () => now,
    });
    expect(authority.revokeAuthenticatedWorkload(workload)).toMatchObject({
      parentCompanionId: PARENT_ID,
      shardId: 'shard-instance-a',
      workloadGeneration: 'generation-1',
    });
    expect(() => authority.resolveAuthenticatedWorkload(workload)).toThrow(/revoked/);
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toThrow(/revoked/);
    expect(registry.resolveAuthenticatedWorkload(workload)).toBeDefined();
  });

  it('audits the complete request lifecycle without raw params, scope, or resolver identity', async () => {
    const auditEvents: unknown[] = [];
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => 30_000,
      grantIdFactory: () => 'request-grant-audited',
      audit: event => auditEvents.push(event),
    });
    const { workload } = registerWorkload(registry);
    const secret = 'raw-secret-token-never-audit';
    const tuple = {
      ...requestTuple(workload),
      scope: `site:test-zone/device:${secret}`,
      params: { command: 'toggle', credential: secret },
    };
    const grant = await activateThroughApprovalQueue({
      authority,
      prepared: authority.prepareRequestGrant(tuple),
      approvalId: 'approval-audited',
      expiresAt: 31_000,
      now: () => 30_000,
      resolverId: `operator-${secret}`,
    });
    authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    });
    authority.recordRequestExecution(grant.grantId, 'executed');
    expect(() => authority.consumeRequestGrant({
      ...tuple,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
    })).toThrow(/already consumed/);

    expect(auditEvents.map(event => (event as { outcome: string }).outcome)).toEqual([
      'prepared',
      'issued',
      'consumed',
      'executed',
      'replay_denied',
    ]);
    expect(auditEvents[1]).toMatchObject({
      decision: 'approve',
      resolverKind: 'operator',
    });
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('params');
    expect(serialized).toContain('scopeDigest');
    expect(serialized).toContain('resolverIdDigest');
  });

  it('audits denial and expiry while leaving no activatable reservation', () => {
    const outcomes: string[] = [];
    const registry = new TestWorkloadRegistry();
    const authority = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => 40_000,
      audit: event => outcomes.push(event.outcome),
    });
    const { workload } = registerWorkload(registry);

    const denied = authority.prepareRequestGrant(requestTuple(workload));
    authority.bindRequestGrant(denied, {
      approvalId: 'approval-denied',
      expiresAt: 41_000,
    });
    authority.recordRequestResolution({
      approvalId: 'approval-denied',
      status: 'denied',
      resolver: { kind: 'operator', id: 'test-operator' },
    });
    expect(() => authority.activateRequestGrant(denied, {}))
      .toThrow(/missing, unbound, or already activated/);

    const expired = authority.prepareRequestGrant(requestTuple(workload));
    authority.bindRequestGrant(expired, {
      approvalId: 'approval-expired',
      expiresAt: 41_000,
    });
    authority.recordRequestResolution({
      approvalId: 'approval-expired',
      status: 'expired',
    });
    expect(outcomes).toEqual(['prepared', 'denied', 'prepared', 'expired']);
  });
});
