import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type {
  CompanionApprovalRequestedPayload,
  CompanionApprovalResolvedPayload,
} from '../../shared/contracts/companion-relay.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import { GatewayNtfyNotifier } from './ntfy-notifier.js';
import {
  createGatewayApprovalBoundaryService,
  resolveGatewayApprovalDisposition,
  type ApprovalBoundaryService,
} from './approval-boundary.js';
import { GatewayErrors } from './protocol.js';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import {
  ShardApprovalGrantAuthority,
  type AuthenticatedShardWorkloadHandle,
  type AuthenticatedShardWorkloadRegistration,
  type AuthenticatedShardWorkloadRegistry,
} from '../../system/capabilities/shard-approval-grants.js';

// Sentinel raw params that MUST never survive redaction into a relay payload.
const SECRET_PARAM = 'raw-secret-token-zzz999';
const SECRET_REASONING = 'private chain-of-thought that must not leak';

const PARENT_A = 'companion-parent-a';
const PARENT_B = 'companion-parent-b';
const OPERATOR = { kind: 'operator' as const, id: 'test-garden-operator' };

class TestWorkloadRegistry implements AuthenticatedShardWorkloadRegistry {
  private readonly records =
    new WeakMap<AuthenticatedShardWorkloadHandle, AuthenticatedShardWorkloadRegistration>();

  register(input: AuthenticatedShardWorkloadRegistration): AuthenticatedShardWorkloadHandle {
    const handle = Object.freeze({
      kind: 'authenticated-shard-workload' as const,
    }) as AuthenticatedShardWorkloadHandle;
    this.records.set(handle, input);
    return handle;
  }

  resolveAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadRegistration | undefined {
    return this.records.get(handle);
  }
}

const noopDock: ChannelOutboundDock = {
  id: 'test-dock',
  outbound: {
    textChunkLimit: 2000,
    sendText: async () => {},
  },
};

interface Harness {
  service: ApprovalBoundaryService;
  eventBus: EventBus;
  requested: Array<{ companionId: string; shardId?: string; payload: CompanionApprovalRequestedPayload }>;
  resolved: Array<{ companionId: string; shardId?: string; payload: CompanionApprovalResolvedPayload }>;
  approvalNotificationFailures: unknown[];
}

function createHarness(
  labels: Record<string, string> = {
    [PARENT_A]: 'Parent A',
    [PARENT_B]: 'Parent B',
  },
  options: {
    capabilityTier?: 'nursery' | 'apprentice' | 'autonomous' | 'custom';
    shardApprovalGrants?: ShardApprovalGrantAuthority;
    notificationSink?: 'configured' | 'unreachable';
  } = {},
): Harness {
  const eventBus = new EventBus();
  const requested: Harness['requested'] = [];
  const resolved: Harness['resolved'] = [];
  const approvalNotificationFailures: unknown[] = [];
  eventBus.on('companion.approval.requested', (event) => {
    requested.push({
      companionId: event.companionId,
      ...(event.shardId !== undefined ? { shardId: event.shardId } : {}),
      payload: event.payload,
    });
  });
  eventBus.on('companion.approval.resolved', (event) => {
    resolved.push({
      companionId: event.companionId,
      ...(event.shardId !== undefined ? { shardId: event.shardId } : {}),
      payload: event.payload,
    });
  });

  const service = createGatewayApprovalBoundaryService({
    policyConfig: {
      workspacePath: '/workspace',
      homeAssistant: {
        enabled: true,
        hubBaseUrl: 'http://hub.test.invalid',
        tokenConfigured: true,
      },
    },
    ntfyNotifier: new GatewayNtfyNotifier(),
    discordAdapter: noopDock,
    ...(options.notificationSink === 'unreachable'
      ? {}
      : { confirmation: { operatorDiscordChannelId: 'operator-test' } }),
    capabilityTierProvider: () => options.capabilityTier ?? 'apprentice',
    eventBus,
    parentLabelProvider: (companionId) => labels[companionId],
    ...(options.shardApprovalGrants
      ? { shardApprovalGrants: options.shardApprovalGrants }
      : {}),
    audit: async () => 1,
    auditComplete: async () => {},
    recordMethodSuccess: () => {},
    recordMethodFailure: () => {},
    recordApprovalNotificationFailure: error => approvalNotificationFailures.push(error),
  });

  return { service, eventBus, requested, resolved, approvalNotificationFailures };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'fs.write',
    action: 'write file',
    scope: '/workspace/todo.txt',
    params: { path: '/workspace/todo.txt', apiKey: SECRET_PARAM, note: SECRET_REASONING },
    companionReason: 'Updating the shared todo list',
    ...overrides,
  };
}

describe('approval attribution — ordinary companion approvals (non-shard)', () => {
  it('keeps an unnotified approval durable and surfaces its sink failure', async () => {
    const h = createHarness({ [PARENT_A]: 'Parent A' }, { notificationSink: 'unreachable' });

    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest(),
      execute: async () => 'ok',
    });

    expect(h.service.listPendingConfirmations()).toEqual([
      expect.objectContaining({ id: entry.id }),
    ]);
    expect(h.approvalNotificationFailures).toEqual([
      expect.objectContaining({ message: expect.stringContaining('no reachable operator notification sink') }),
    ]);
  });

  it('enqueues with the parent owner and emits requested/resolved without shardId', async () => {
    const h = createHarness();
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest(),
      execute: async () => 'ok',
    });

    await vi.waitFor(() => expect(h.requested).toHaveLength(1));
    const req = h.requested[0];
    expect(req.companionId).toBe(PARENT_A);
    expect(req).not.toHaveProperty('shardId');
    expect(req.payload.attribution).toEqual({ parentId: PARENT_A, parentLabel: 'Parent A' });
    // Raw tool params / reasoning never survive redaction into the payload.
    const serialized = JSON.stringify(req.payload);
    expect(serialized).not.toContain(SECRET_PARAM);
    expect(serialized).not.toContain(SECRET_REASONING);
    expect(serialized).not.toContain('params');

    const result = await h.service.resolveConfirmation({ id: entry.id, decision: 'approve' });
    expect(result.status).toBe('approved');
    await vi.waitFor(() => expect(h.resolved).toHaveLength(1));
    expect(h.resolved[0].companionId).toBe(PARENT_A);
    expect(h.resolved[0]).not.toHaveProperty('shardId');
    expect(h.resolved[0].payload).not.toHaveProperty('shardId');
    expect(h.resolved[0].payload.status).toBe('approved');
  });

  it('keeps ownerOfConfirmation returning the parent companion id', async () => {
    const h = createHarness();
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest(),
      execute: async () => 'ok',
    });
    expect(h.service.ownerOfConfirmation(entry.id)).toBe(PARENT_A);
    expect(entry.approvalOwner).toEqual({ companionId: PARENT_A });

    await h.service.resolveConfirmation({ id: entry.id, decision: 'deny' });
    expect(h.service.ownerOfConfirmation(entry.id)).toBe(PARENT_A);
  });

  it('threads durable post-enqueue and denial lifecycle hooks through the real confirmation boundary', async () => {
    const h = createHarness();
    const afterEnqueued = vi.fn(async () => undefined);
    const onDenied = vi.fn(async () => undefined);
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest({
        resolutionAuthority: 'operator',
      }),
      execute: async () => 'not-run',
      afterEnqueued,
      onDenied,
    });

    expect(afterEnqueued).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id }));
    await expect(h.service.resolveConfirmation(
      { id: entry.id, decision: 'deny' },
      OPERATOR,
    )).resolves.toMatchObject({ status: 'denied', executed: false });
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      status: 'denied',
      resolver: OPERATOR,
    }));
  });

  it('does not acknowledge post-enqueue state when the Partner alert surface rejects delivery', async () => {
    const h = createHarness();
    const afterEnqueued = vi.fn(async () => undefined);
    h.eventBus.on('companion.approval.requested', async () => {
      throw new Error('Partner relay unavailable');
    });

    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest({ resolutionAuthority: 'operator' }),
      execute: async () => 'not-run',
      requirePartnerAlertDelivery: true,
      afterEnqueued,
    })).rejects.toThrow('Partner relay unavailable');
    expect(afterEnqueued).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmations()).toEqual([]);
  });

  it('overwrites caller-supplied attribution with an explicit unknown label when no roster label resolves', async () => {
    const h = createHarness({});
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest({
        attribution: { parentId: PARENT_A, parentLabel: 'Spoofed' },
      }),
      execute: async () => 'ok',
    });

    // A caller-supplied label is never authority. The exact stable id remains
    // machine-readable while the human-facing label stays honest and readable.
    expect(entry.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: 'Unknown companion · companion-parent-a',
    });
    await vi.waitFor(() => expect(h.requested).toHaveLength(1));
    expect(h.requested[0].payload.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: 'Unknown companion · companion-parent-a',
    });
    expect(JSON.stringify(h.requested)).not.toContain('Spoofed');
  });
});

describe('approval attribution — authenticated shard requests', () => {
  it('retains the exact parent companionId plus the unique shardId across request and resolution', async () => {
    const h = createHarness();
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'shard-instance-1', shardLabel: 'Research Shard' },
      request: baseRequest(),
      execute: async () => 'ok',
    });

    await vi.waitFor(() => expect(h.requested).toHaveLength(1));
    const req = h.requested[0];
    expect(req.companionId).toBe(PARENT_A);
    expect(req.shardId).toBe('shard-instance-1');
    expect(req.payload.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: 'Parent A',
      shardId: 'shard-instance-1',
      shardLabel: 'Research Shard',
    });
    // The queued record carries immutable shard provenance too.
    const pending = h.service.listPendingConfirmations().find((p) => p.id === entry.id);
    expect(pending?.attribution?.shardId).toBe('shard-instance-1');
    expect(pending?.approvalOwner).toEqual({
      companionId: PARENT_A,
      shardId: 'shard-instance-1',
    });

    await h.service.resolveConfirmation({ id: entry.id, decision: 'approve' });
    await vi.waitFor(() => expect(h.resolved).toHaveLength(1));
    expect(h.resolved[0].companionId).toBe(PARENT_A);
    expect(h.resolved[0].shardId).toBe('shard-instance-1');
    expect(h.resolved[0].payload.shardId).toBe('shard-instance-1');
  });

  it('never lets a leaked approval id re-attribute a sibling parent/shard', async () => {
    const h = createHarness();
    const a = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'shard-a' },
      request: baseRequest(),
      execute: async () => 'ok',
    });
    await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_B,
      shardLineage: { shardId: 'shard-b' },
      request: baseRequest(),
      execute: async () => 'ok',
    });

    // Resolving A's id (even if B knew it) emits A's captured attribution only.
    await h.service.resolveConfirmation({ id: a.id, decision: 'approve' });
    await vi.waitFor(() => expect(h.resolved).toHaveLength(1));
    expect(h.resolved[0].companionId).toBe(PARENT_A);
    expect(h.resolved[0].shardId).toBe('shard-a');
  });

  it('scopes simultaneous parent queues and denies leaked-id resolution by stored owner', async () => {
    const h = createHarness();
    const executeA = vi.fn(async () => 'a');
    const executeB = vi.fn(async () => 'b');
    const a = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'shard-a' },
      request: baseRequest({ scope: '/workspace/a.txt' }),
      execute: executeA,
    });
    const b = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_B,
      shardLineage: { shardId: 'shard-b' },
      request: baseRequest({ scope: '/workspace/b.txt' }),
      execute: executeB,
    });

    expect(h.service.listPendingConfirmationsForOwner(PARENT_A).map(entry => entry.id))
      .toEqual([a.id]);
    expect(h.service.listPendingConfirmationsForOwner(PARENT_B).map(entry => entry.id))
      .toEqual([b.id]);

    await expect(h.service.resolveConfirmationForOwner(
      PARENT_B,
      { id: a.id, decision: 'approve' },
      { kind: 'operator', id: 'parent-b-operator' },
    )).resolves.toMatchObject({ id: a.id, status: 'not_found', executed: false });
    expect(executeA).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmationsForOwner(PARENT_A).map(entry => entry.id))
      .toEqual([a.id]);

    await expect(h.service.resolveConfirmationForOwner(
      PARENT_A,
      { id: a.id, decision: 'approve' },
      { kind: 'operator', id: 'parent-a-operator' },
    )).resolves.toMatchObject({ id: a.id, status: 'approved', executed: true });
    expect(executeA).toHaveBeenCalledOnce();
    expect(executeB).not.toHaveBeenCalled();
  });
});

describe('approval-bound shard request grants', () => {
  function createShardHarness(capabilityTier: 'apprentice' | 'autonomous' = 'apprentice') {
    const registry = new TestWorkloadRegistry();
    const grants = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      now: () => Date.now(),
      grantIdFactory: () => 'boundary-request-grant',
    });
    const derived = deriveShardCapabilityGrant({
      companionId: PARENT_A,
      tier: 'custom',
      customTokens: [...CAPABILITY_TOKENS],
    });
    const workload = registry.register({
      parentCompanionId: PARENT_A,
      shardId: 'shard-instance-authenticated',
      workloadGeneration: 'workload-generation-1',
      shardLabel: 'Authenticated Shard',
      capabilityGrant: derived,
    });
    return {
      grants,
      workload,
      harness: createHarness({
        [PARENT_A]: 'Parent A',
        [PARENT_B]: 'Parent B',
      }, { capabilityTier, shardApprovalGrants: grants }),
    };
  }

  it('derives lineage from the authenticated workload handle and executes the queued tuple once', async () => {
    const { harness: h, workload } = createShardHarness();
    const execute = vi.fn(async () => 'ok');
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardGrant: { workload },
      request: baseRequest({
        method: 'home_assistant.call_service',
        action: 'home_assistant.control',
        scope: 'site:test-zone/device:test-switch',
        params: { command: 'toggle' },
      }),
      execute,
    });

    expect(entry.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: 'Parent A',
      shardId: 'shard-instance-authenticated',
      shardLabel: 'Authenticated Shard',
    });
    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'approve',
    }, { kind: 'companion', id: PARENT_A })).resolves.toMatchObject({
      status: 'failed',
      executed: false,
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'approve',
    }, OPERATOR)).resolves.toMatchObject({ status: 'approved', executed: true });
    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'not_found', executed: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects modified parameters without executing or leaving residual request authority', async () => {
    const { harness: h, workload } = createShardHarness();
    const execute = vi.fn(async () => 'ok');
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardGrant: { workload },
      request: baseRequest({
        method: 'home_assistant.call_service',
        action: 'home_assistant.control',
        scope: 'site:test-zone/device:test-switch',
        params: { command: 'toggle' },
      }),
      execute,
    });

    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'modify',
      modifiedParams: { command: 'unlock' },
    }, OPERATOR)).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(execute).not.toHaveBeenCalled();
    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'not_found', executed: false });
  });

  it('does not let an autonomous parent auto-clear a shard-specific fence', async () => {
    const { harness: h, workload } = createShardHarness('autonomous');
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'home_assistant.call_service',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'home_assistant.control',
      approvalScope: () => 'site:test-zone/device:test-switch',
      shardApprovalGrant: () => ({ workload }),
    });

    await expect(dispatch({ command: 'toggle' })).rejects.toMatchObject({
      code: GatewayErrors.NEEDS_APPROVAL,
    });
    expect(handler).not.toHaveBeenCalled();
    const [pending] = h.service.listPendingConfirmations();
    expect(pending.attribution?.shardId).toBe('shard-instance-authenticated');
    await h.service.resolveConfirmation({ id: pending.id, decision: 'approve' }, OPERATOR);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects parent, lineage, and handle mismatches before enqueue', async () => {
    const { harness: h, workload } = createShardHarness();
    const request = baseRequest({
      method: 'home_assistant.call_service',
      action: 'home_assistant.control',
      scope: 'site:test-zone/device:test-switch',
      params: { command: 'toggle' },
    });

    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_B,
      shardGrant: { workload },
      request,
      execute: async () => 'ok',
    })).rejects.toThrow(/workload parent does not match/);

    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'spoofed-shard' },
      shardGrant: { workload },
      request,
      execute: async () => 'ok',
    })).rejects.toThrow(/attribution does not match the authenticated workload/);

    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardGrant: {
        workload: { kind: 'authenticated-shard-workload' } as typeof workload,
      },
      request,
      execute: async () => 'ok',
    })).rejects.toThrow(/missing, replaced, or revoked/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('denies a shard-originated gated method that is not an eligible exceptional action (never auto-clears)', async () => {
    const { harness: h, workload } = createShardHarness('autonomous');
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'fs.write',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'write file',
      approvalScope: () => '/outside/todo.txt',
      shardApprovalGrant: () => ({ workload }),
    });

    // fs.write outside the workspace is AUTONOMOUS_TIER_REQUIRED for a parent; with
    // authenticated shard lineage on a non-eligible method it must deny —
    // never auto-clear, never enqueue a grantless shard approval.
    await expect(dispatch({ path: '/outside/todo.txt' })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('denies when the shard lineage resolver itself throws, even with no grant authority configured', async () => {
    // No shardApprovalGrants wired at all — the fence must still hold.
    const h = createHarness({ [PARENT_A]: 'Parent A' }, { capabilityTier: 'autonomous' });
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'home_assistant.call_service',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'home_assistant.control',
      approvalScope: () => 'site:test-zone/device:test-switch',
      shardApprovalGrant: () => {
        throw new Error('Shard-originated request denied: no live authenticated shard workload');
      },
    });

    await expect(dispatch({ command: 'toggle' }))
      .rejects.toThrow(/no live authenticated shard workload/);
    expect(handler).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('propagates a terminal denial audit failure instead of silently completing (2h6q.3)', async () => {
    const registry = new TestWorkloadRegistry();
    let failTerminalAudit = true;
    const auditOutcomes: string[] = [];
    const grants = new ShardApprovalGrantAuthority({
      workloadRegistry: registry,
      audit: (event) => {
        if (failTerminalAudit && event.outcome === 'denied') {
          throw new Error('injected boundary terminal audit failure');
        }
        auditOutcomes.push(event.outcome);
      },
    });
    const derived = deriveShardCapabilityGrant({
      companionId: PARENT_A,
      tier: 'custom',
      customTokens: [...CAPABILITY_TOKENS],
    });
    const workload = registry.register({
      parentCompanionId: PARENT_A,
      shardId: 'shard-instance-audit',
      workloadGeneration: 'workload-generation-audit',
      capabilityGrant: derived,
    });
    const h = createHarness({ [PARENT_A]: 'Parent A' }, { shardApprovalGrants: grants });
    const execute = vi.fn(async () => 'ok');
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardGrant: { workload },
      request: baseRequest({
        method: 'home_assistant.call_service',
        action: 'home_assistant.control',
        scope: 'site:test-zone/device:test-switch',
        params: { command: 'toggle' },
      }),
      execute,
    });

    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'deny',
    }, OPERATOR)).rejects.toThrow(/injected boundary terminal audit failure/);
    expect(execute).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmations()).toEqual([
      expect.objectContaining({ id: entry.id }),
    ]);
    expect(h.resolved).toHaveLength(0);

    // The same public resolution is retryable: the audit commits first, then
    // the queue terminalizes and emits exactly one resolution.
    failTerminalAudit = false;
    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'deny',
    }, OPERATOR)).resolves.toMatchObject({
      id: entry.id,
      status: 'denied',
      executed: false,
    });
    expect(auditOutcomes).toEqual(['prepared', 'denied']);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
    await vi.waitFor(() => expect(h.resolved).toHaveLength(1));

    await expect(h.service.resolveConfirmation({
      id: entry.id,
      decision: 'approve',
    }, OPERATOR)).resolves.toMatchObject({
      status: 'not_found',
      executed: false,
    });
    expect(auditOutcomes).toEqual(['prepared', 'denied']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('auto-clears only autonomous-tier-eligible escalation for an autonomous companion', async () => {
    const h = createHarness({
      [PARENT_A]: 'Parent A',
      [PARENT_B]: 'Parent B',
    }, { capabilityTier: 'autonomous' });
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'fs.read',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'read file',
      approvalScope: () => '/outside/reference.txt',
    });

    await expect(dispatch({ path: '/outside/reference.txt' })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('never auto-clears a human-only decision for an autonomous companion', async () => {
    const h = createHarness({ [PARENT_A]: 'Parent A' }, { capabilityTier: 'autonomous' });
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'git.commit',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'commit',
      approvalScope: () => 'repository',
    });

    await expect(dispatch({ message: 'change', intent: 'test' })).rejects.toMatchObject({
      code: GatewayErrors.NEEDS_APPROVAL,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(h.service.listPendingConfirmations()).toHaveLength(1);
  });

  it('fails closed when policy returns an unknown approval class', () => {
    expect(resolveGatewayApprovalDisposition('UNKNOWN_POLICY_CLASS', 'autonomous')).toBe('deny');
  });
});

describe('approval attribution — fail-closed lineage refusal BEFORE enqueue', () => {
  it('refuses an ownerless request and never enqueues or emits', async () => {
    const h = createHarness();
    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: undefined,
      request: baseRequest(),
      execute: async () => 'ok',
    })).rejects.toThrow(/no authenticated companion owner/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    expect(h.requested).toHaveLength(0);
  });

  it('refuses an orphaned shard lineage (empty shard instance id) before enqueue', async () => {
    const h = createHarness();
    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: '   ' },
      request: baseRequest(),
      execute: async () => 'ok',
    })).rejects.toThrow(/no authenticated shard instance id/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    expect(h.requested).toHaveLength(0);
  });

  it('refuses a request whose supplied attribution parent mismatches the authenticated owner', async () => {
    const h = createHarness();
    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest({
        attribution: { parentId: PARENT_B, parentLabel: 'Spoofed' },
      }),
      execute: async () => 'ok',
    })).rejects.toThrow(/does not match the authenticated owner/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('refuses a request whose supplied attribution shard mismatches the authenticated shard lineage', async () => {
    const h = createHarness();
    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'shard-a' },
      request: baseRequest({
        attribution: { parentId: PARENT_A, parentLabel: 'Parent A', shardId: 'shard-evil' },
      }),
      execute: async () => 'ok',
    })).rejects.toThrow(/does not match the authenticated shard lineage/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });

  it('uses an explicit unknown label when an ordinary companion has no cosmetic label', async () => {
    const h = createHarness({}); // no labels resolvable
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest(),
      execute: async () => 'ok',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(entry.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: 'Unknown companion · companion-parent-a',
    });
    expect(h.service.listPendingConfirmationsForOwner(PARENT_A)).toHaveLength(1);
    expect(h.requested).toEqual([
      expect.objectContaining({
        companionId: PARENT_A,
        payload: expect.objectContaining({
          id: entry.id,
          attribution: {
            parentId: PARENT_A,
            parentLabel: 'Unknown companion · companion-parent-a',
          },
        }),
      }),
    ]);
  });
});

describe('approval boundary pre-policy guard', () => {
  it('denies before policy summaries or handler dispatch', async () => {
    const h = createHarness();
    const prePolicyGuard = vi.fn(() => {
      throw new Error('blocked by protected-owner guard');
    });
    const paramsSummary = vi.fn(() => ({ path: 'must-not-be-summarized' }));
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'fs.write',
      handler,
      paramsSummary,
      prePolicyGuard,
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'write',
      approvalScope: () => 'protected-owner',
    });

    await expect(dispatch({ path: '/private/persona-owner.json' }))
      .rejects.toThrow('blocked by protected-owner guard');
    expect(prePolicyGuard).toHaveBeenCalledOnce();
    expect(paramsSummary).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
