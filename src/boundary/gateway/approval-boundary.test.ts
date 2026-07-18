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
  requested: Array<{ companionId: string; shardId?: string; payload: CompanionApprovalRequestedPayload }>;
  resolved: Array<{ companionId: string; shardId?: string; payload: CompanionApprovalResolvedPayload }>;
}

function createHarness(
  labels: Record<string, string> = {
    [PARENT_A]: 'Parent A',
    [PARENT_B]: 'Parent B',
  },
  options: {
    capabilityTier?: 'nursery' | 'apprentice' | 'autonomous' | 'custom';
    shardApprovalGrants?: ShardApprovalGrantAuthority;
  } = {},
): Harness {
  const eventBus = new EventBus();
  const requested: Harness['requested'] = [];
  const resolved: Harness['resolved'] = [];
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
  });

  return { service, requested, resolved };
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
  });

  it('drops caller-supplied attribution when no canonical parent label resolves', async () => {
    const h = createHarness({});
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest({
        attribution: { parentId: PARENT_A, parentLabel: 'Spoofed' },
      }),
      execute: async () => 'ok',
    });

    expect(entry).not.toHaveProperty('attribution');
    expect(h.service.listPendingConfirmations()).toEqual([
      expect.not.objectContaining({ attribution: expect.anything() }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.requested).toHaveLength(0);
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

  it('preserves ordinary autonomous companion auto-clear behavior', async () => {
    const h = createHarness({
      [PARENT_A]: 'Parent A',
      [PARENT_B]: 'Parent B',
    }, { capabilityTier: 'autonomous' });
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatch = h.service.gate({
      method: 'image.create',
      handler,
      paramsSummary: () => ({}),
      authenticatedCompanionId: () => PARENT_A,
      approvalAction: 'image.create',
      approvalScope: () => 'generated-image',
    });

    await expect(dispatch({ prompt: 'test image' })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
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

  it('refuses a shard request with no resolvable parent label rather than emitting unlabeled', async () => {
    const h = createHarness({}); // no labels resolvable
    await expect(h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      shardLineage: { shardId: 'shard-a' },
      request: baseRequest(),
      execute: async () => 'ok',
    })).rejects.toThrow(/no resolvable parent companion label/);
    expect(h.service.listPendingConfirmations()).toHaveLength(0);
  });
});
