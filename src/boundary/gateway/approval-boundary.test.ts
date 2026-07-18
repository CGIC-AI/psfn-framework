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

// Sentinel raw params that MUST never survive redaction into a relay payload.
const SECRET_PARAM = 'raw-secret-token-zzz999';
const SECRET_REASONING = 'private chain-of-thought that must not leak';

const PARENT_A = 'companion-parent-a';
const PARENT_B = 'companion-parent-b';

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

function createHarness(labels: Record<string, string> = {
  [PARENT_A]: 'Parent A',
  [PARENT_B]: 'Parent B',
}): Harness {
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
    policyConfig: { workspacePath: '/workspace' },
    ntfyNotifier: new GatewayNtfyNotifier(),
    discordAdapter: noopDock,
    capabilityTierProvider: () => 'default',
    eventBus,
    parentLabelProvider: (companionId) => labels[companionId],
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
    expect(entry.approvalOwner).toEqual({ companionId: PARENT_A });

    await h.service.resolveConfirmation({ id: entry.id, decision: 'deny' });
    expect(h.service.ownerOfConfirmation(entry.id)).toBe(PARENT_A);
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

  it('uses the authenticated stable id when an ordinary companion has no cosmetic label', async () => {
    const h = createHarness({}); // no labels resolvable
    const entry = await h.service.requestExplicitApproval({
      authenticatedCompanionId: PARENT_A,
      request: baseRequest(),
      execute: async () => 'ok',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(entry.attribution).toEqual({
      parentId: PARENT_A,
      parentLabel: PARENT_A,
    });
    expect(h.service.listPendingConfirmationsForOwner(PARENT_A)).toHaveLength(1);
    expect(h.requested).toEqual([
      expect.objectContaining({
        companionId: PARENT_A,
        payload: expect.objectContaining({
          id: entry.id,
          attribution: {
            parentId: PARENT_A,
            parentLabel: PARENT_A,
          },
        }),
      }),
    ]);
  });
});
