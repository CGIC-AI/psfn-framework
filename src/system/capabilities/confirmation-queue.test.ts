import { describe, it, expect, vi } from 'vitest';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
  readConfirmedApprovalExecution,
  type ConfirmationExecutionContext,
} from './confirmation-queue.js';

describe('ConfirmationQueue', () => {
  it('uses native defensive-copy semantics for in-memory params', () => {
    const observedAt = new Date('2026-08-06T12:00:00.000Z');
    const params: Record<string, unknown> = {
      observedAt,
      optional: undefined,
      rows: [undefined, { label: 'kept' }],
      nested: { enabled: true },
    };
    const queue = new ConfirmationQueue({ now: () => 1, idFactory: () => 'native-clone' });

    const entry = queue.enqueue({
      method: 'fs.write',
      action: 'write',
      scope: '/tmp/native-clone',
      params,
      companionReason: 'Verify native clone semantics',
    }, async () => undefined);

    expect(entry.params.observedAt).toBeInstanceOf(Date);
    expect(entry.params.observedAt).not.toBe(observedAt);
    expect(Object.hasOwn(entry.params, 'optional')).toBe(true);
    expect(entry.params.rows).toEqual([undefined, { label: 'kept' }]);
    expect(entry.params.rows).not.toBe(params.rows);
    expect(entry.params.nested).not.toBe(params.nested);

    const wireProjection = JSON.parse(JSON.stringify({ entries: queue.listPending() })) as {
      entries: Array<{ params: Record<string, unknown> }>;
    };
    expect(wireProjection.entries[0]?.params).toEqual({
      observedAt: '2026-08-06T12:00:00.000Z',
      rows: [null, { label: 'kept' }],
      nested: { enabled: true },
    });
  });

  it('rejects wire-unrepresentable params before queue admission', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const unsupported = [
      { label: 'cyclic', params: cyclic },
      { label: 'BigInt', params: { value: 1n } },
      { label: 'function', params: { callback: () => undefined } },
      { label: 'Map', params: { values: new Map([['key', 'value']]) } },
      { label: 'non-finite number', params: { value: Number.NaN } },
    ];

    for (const testCase of unsupported) {
      const queue = new ConfirmationQueue({
        now: () => 1,
        idFactory: () => `unsupported-${testCase.label}`,
      });
      expect(() => queue.enqueue({
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/unsupported',
        params: testCase.params,
        companionReason: `Reject unsupported ${testCase.label} values`,
      }, async () => undefined), testCase.label).toThrow();
      expect(queue.listPending(), testCase.label).toEqual([]);
    }
  });

  it('enqueues pending actions with timestamp and expiry metadata', () => {
    let now = 10_000;
    let sequence = 0;
    const queue = new ConfirmationQueue({
      now: () => now,
      idFactory: () => `cq-${++sequence}`,
      defaultExpiryMs: 5_000,
    });

    const entry = queue.enqueue(
      {
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/notes.txt',
        params: { path: '/tmp/notes.txt', content: 'hello' },
        companionReason: 'Updating note file',
      },
      async () => undefined,
    );

    expect(entry.id).toBe('cq-1');
    expect(entry.requestedAt).toBe(10_000);
    expect(entry.expiresAt).toBe(15_000);
    expect(entry.companionReason).toBe('Updating note file');
    expect(queue.listPending()).toEqual([entry]);

    now += 1_000;
    expect(queue.getPending(entry.id)?.id).toBe(entry.id);
  });

  it('carries optional unified-envelope provenance immutably and omits it by default', () => {
    const queue = new ConfirmationQueue({ now: () => 1, idFactory: () => 'prov-1' });

    const plain = queue.enqueue(
      {
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/a.txt',
        params: {},
        companionReason: 'plain entry',
      },
      async () => undefined,
    );
    expect(plain).not.toHaveProperty('sourceSystem');
    expect(plain).not.toHaveProperty('attribution');

    const attribution = { parentId: 'parent-1', parentLabel: 'Parent', shardId: 'shard-1' };
    const approvalOwner = { companionId: 'parent-1', shardId: 'shard-1' };
    const rich = queue.enqueue(
      {
        method: 'world.control',
        action: 'toggle',
        scope: 'living-room',
        params: {},
        companionReason: 'shard entry',
        sourceSystem: 'shard',
        attribution,
        approvalOwner,
      },
      async () => undefined,
    );
    expect(rich.sourceSystem).toBe('shard');
    expect(rich.attribution).toEqual(attribution);
    expect(rich.approvalOwner).toEqual(approvalOwner);
    // Snapshot must be a defensive copy — mutating the returned entry or the
    // source attribution must not bleed into queue state.
    expect(rich.attribution).not.toBe(attribution);
    attribution.parentId = 'tampered';
    approvalOwner.companionId = 'tampered';
    expect(queue.getPending('prov-1')?.attribution?.parentId).toBe('parent-1');
    expect(queue.getApprovalOwner('prov-1')).toEqual({
      companionId: 'parent-1',
      shardId: 'shard-1',
    });
  });

  it('reads the stored owner without consuming the queue expiry outcome', async () => {
    let now = 1;
    const queue = new ConfirmationQueue({
      now: () => now,
      idFactory: () => 'owner-expiry',
      defaultExpiryMs: 10,
    });
    queue.enqueue({
      method: 'fs.write',
      action: 'write',
      scope: '/tmp/a.txt',
      params: {},
      companionReason: 'write',
      approvalOwner: { companionId: 'parent-1' },
    }, async () => undefined);
    now = 20;

    expect(queue.getApprovalOwner('owner-expiry')).toEqual({
      companionId: 'parent-1',
    });
    await expect(queue.resolve({
      id: 'owner-expiry',
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'expired', executed: false });
  });

  it('approves and executes queued action', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const queue = new ConfirmationQueue({
      now: () => 100,
      idFactory: () => 'approve-1',
    });
    const entry = queue.enqueue(
      {
        method: 'fs.read',
        action: 'read',
        scope: '/etc/hosts',
        params: { path: '/etc/hosts' },
        companionReason: 'Need to inspect hosts',
      },
      execute,
    );

    const result = await queue.resolve({
      id: entry.id,
      decision: 'approve',
    });

    expect(result).toEqual({
      id: entry.id,
      status: 'approved',
      message: 'Action approved and executed.',
      executed: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { path: '/etc/hosts' },
      expect.objectContaining({ id: entry.id, method: 'fs.read' }),
      {},
    );
    expect(queue.listPending()).toEqual([]);
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'approved',
        decision: 'approve',
        executed: true,
        message: 'Action approved and executed.',
        appliedParams: { path: '/etc/hosts' },
      }),
    ]);
  });

  it('exposes approval proof only during the exact queue executor call', async () => {
    let captured: ConfirmationExecutionContext | undefined;
    const queue = new ConfirmationQueue({
      now: () => 150,
      idFactory: () => 'approval-proof-1',
    });
    const entry = queue.enqueue({
      method: 'fs.read',
      action: 'read',
      scope: '/etc/hosts',
      params: {},
      companionReason: 'Inspect a bounded resource',
    }, async (_params, runEntry, context) => {
      captured = context;
      expect(readConfirmedApprovalExecution(context, runEntry.id)).toEqual({
        approvalId: runEntry.id,
        decision: 'approve',
        resolver: { kind: 'operator', id: 'test-operator' },
      });
    });

    await queue.resolve(
      { id: entry.id, decision: 'approve' },
      { kind: 'operator', id: 'test-operator' },
    );
    expect(captured).toBeDefined();
    if (!captured) {
      throw new Error('Test executor did not capture its confirmation context');
    }
    expect(() => readConfirmedApprovalExecution(captured, entry.id))
      .toThrow(/not backed by the resolved approval/);
  });

  it('denies queued action without executing it', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const queue = new ConfirmationQueue({
      now: () => 200,
      idFactory: () => 'deny-1',
    });
    const entry = queue.enqueue(
      {
        method: 'web.fetch',
        action: 'fetch',
        scope: 'https://example.com',
        params: { url: 'https://example.com' },
        companionReason: 'Research task',
      },
      execute,
    );

    const result = await queue.resolve({
      id: entry.id,
      decision: 'deny',
    });

    expect(result).toEqual({
      id: entry.id,
      status: 'denied',
      message: 'Action denied by operator.',
      executed: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(queue.listPending()).toEqual([]);
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'denied',
        decision: 'deny',
        executed: false,
        message: 'Action denied by operator.',
      }),
    ]);
  });

  it('persists denial through the lifecycle hook before terminalizing', async () => {
    const onDenied = vi.fn().mockResolvedValue(undefined);
    const queue = new ConfirmationQueue({ now: () => 250, idFactory: () => 'deny-hook' });
    const entry = queue.enqueue({
      method: 'memory.deletion.validate',
      action: 'validate',
      scope: 'memory:one',
      params: { proposalId: 'deny-hook' },
      companionReason: 'Validate deletion proposal',
      resolutionAuthority: 'operator',
    }, async () => undefined, { onDenied });

    await expect(queue.resolve(
      { id: entry.id, decision: 'deny' },
      { kind: 'operator', id: 'operator-1' },
    )).resolves.toMatchObject({ status: 'denied', executed: false });
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      status: 'denied',
      resolver: { kind: 'operator', id: 'operator-1' },
    }));
  });

  it('keeps a denial pending when its durable lifecycle hook fails', async () => {
    const queue = new ConfirmationQueue({ now: () => 260, idFactory: () => 'deny-retry' });
    const entry = queue.enqueue({
      method: 'memory.deletion.validate',
      action: 'validate',
      scope: 'memory:one',
      params: {},
      companionReason: 'Validate deletion proposal',
      resolutionAuthority: 'operator',
    }, async () => undefined, {
      onDenied: async () => { throw new Error('proposal store unavailable'); },
    });

    await expect(queue.resolve(
      { id: entry.id, decision: 'deny' },
      { kind: 'operator', id: 'operator-1' },
    )).resolves.toEqual({
      id: entry.id,
      status: 'failed',
      message: 'proposal store unavailable',
      executed: false,
    });
    expect(queue.getPending(entry.id)?.id).toBe(entry.id);
    expect(queue.listHistory()).toEqual([]);
  });

  it('refreshes a pending executor after an agent reconnect without changing immutable request data', async () => {
    const queue = new ConfirmationQueue({ now: () => 270, idFactory: () => 'refresh-1' });
    const staleExecute = vi.fn(async () => { throw new Error('stale agent connection'); });
    const freshExecute = vi.fn(async () => undefined);
    const entry = queue.enqueue({
      method: 'memory.deletion.validate',
      action: 'validate',
      scope: 'memory:one',
      params: { proposalId: 'proposal-1' },
      companionReason: 'Validate deletion proposal',
      resolutionAuthority: 'operator',
    }, staleExecute);

    const refreshed = queue.refreshPending(entry.id, freshExecute);
    expect(refreshed).toEqual(entry);
    await expect(queue.resolve(
      { id: entry.id, decision: 'approve' },
      { kind: 'operator', id: 'operator-1' },
    )).resolves.toMatchObject({ status: 'approved', executed: true });
    expect(staleExecute).not.toHaveBeenCalled();
    expect(freshExecute).toHaveBeenCalledOnce();
  });

  it('modifies params before execution when operator selects modify', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const queue = new ConfirmationQueue({
      now: () => 500,
      idFactory: () => 'modify-1',
    });
    const entry = queue.enqueue(
      {
        method: 'web.fetch',
        action: 'fetch',
        scope: 'https://example.com',
        params: { url: 'https://example.com', prompt: 'original' },
        companionReason: 'Read docs',
      },
      execute,
    );

    const result = await queue.resolve({
      id: entry.id,
      decision: 'modify',
      modifiedParams: {
        url: 'https://example.com/docs',
        prompt: 'operator-adjusted prompt',
      },
    });

    expect(result).toEqual({
      id: entry.id,
      status: 'modified',
      message: 'Action executed with modified parameters.',
      executed: true,
    });
    expect(execute).toHaveBeenCalledWith(
      {
        url: 'https://example.com/docs',
        prompt: 'operator-adjusted prompt',
      },
      expect.objectContaining({ id: entry.id }),
      {},
    );
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'modified',
        decision: 'modify',
        executed: true,
        message: 'Action executed with modified parameters.',
        appliedParams: {
          url: 'https://example.com/docs',
          prompt: 'operator-adjusted prompt',
        },
      }),
    ]);
  });

  it('rejects modify decisions without a JSON object payload', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const queue = new ConfirmationQueue({
      now: () => 600,
      idFactory: () => 'modify-missing',
    });
    const entry = queue.enqueue(
      {
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/file',
        params: { path: '/tmp/file', content: 'a' },
        companionReason: 'Write result',
      },
      execute,
    );

    const result = await queue.resolve({
      id: entry.id,
      decision: 'modify',
    });

    expect(result).toEqual({
      id: entry.id,
      status: 'failed',
      message: 'Modified params are required and must be a JSON object.',
      executed: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(queue.getPending(entry.id)?.id).toBe(entry.id);
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'failed',
        decision: 'modify',
        executed: false,
        message: 'Modified params are required and must be a JSON object.',
      }),
    ]);
  });

  it('records failed execution outcomes explicitly in history', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('simulated execution failure'));
    const queue = new ConfirmationQueue({
      now: () => 700,
      idFactory: () => 'failed-exec-1',
    });
    const entry = queue.enqueue(
      {
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/failure',
        params: { path: '/tmp/failure', content: 'x' },
        companionReason: 'Write result',
      },
      execute,
    );

    const result = await queue.resolve({
      id: entry.id,
      decision: 'approve',
    });

    expect(result).toEqual({
      id: entry.id,
      status: 'failed',
      message: 'simulated execution failure',
      executed: false,
    });
    expect(queue.getPending(entry.id)).toBeNull();
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'failed',
        decision: 'approve',
        executed: false,
        message: 'simulated execution failure',
        appliedParams: { path: '/tmp/failure', content: 'x' },
        error: 'simulated execution failure',
      }),
    ]);
  });

  it('expires stale requests using configured timeout', async () => {
    let now = 1_000;
    const queue = new ConfirmationQueue({
      now: () => now,
      idFactory: () => 'expiry-1',
      defaultExpiryMs: 100,
    });

    const entry = queue.enqueue(
      {
        method: 'fs.read',
        action: 'read',
        scope: '/etc/passwd',
        params: { path: '/etc/passwd' },
        companionReason: 'Debug check',
      },
      async () => undefined,
    );

    now = 1_101;
    expect(queue.expirePending()).toBe(1);
    expect(queue.getPending(entry.id)).toBeNull();
    const result = await queue.resolve({
      id: entry.id,
      decision: 'approve',
    });
    expect(result.status).toBe('not_found');
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'expired',
        executed: false,
        message: 'Confirmation request expired before resolution.',
      }),
    ]);
  });

  it('falls back to 24h default expiry when configured value is invalid', () => {
    const queue = new ConfirmationQueue({
      now: () => 5_000,
      idFactory: () => 'default-expiry',
      defaultExpiryMs: -1,
    });

    const entry = queue.enqueue(
      {
        method: 'fs.write',
        action: 'write',
        scope: '/tmp/default-expiry',
        params: { path: '/tmp/default-expiry', content: 'x' },
        companionReason: 'Test default timeout',
      },
      async () => undefined,
    );

    expect(entry.expiresAt).toBe(5_000 + DEFAULT_CONFIRMATION_EXPIRY_MS);
  });

  it('keeps operator-only requests pending when a companion tries to resolve them', async () => {
    const execute = vi.fn();
    const queue = new ConfirmationQueue({ idFactory: () => 'operator-only' });
    queue.enqueue({
      method: 'kube.self_management',
      action: 'restart',
      scope: 'psfn-test/psfn',
      params: { action: 'restart' },
      companionReason: 'Restart reviewed release',
      resolutionAuthority: 'operator',
    }, execute);

    const companionResult = await queue.resolve(
      { id: 'operator-only', decision: 'approve' },
      { kind: 'companion', id: 'companion-1' },
    );
    const operatorResult = await queue.resolve(
      { id: 'operator-only', decision: 'approve' },
      { kind: 'operator', id: 'garden-admin' },
    );

    expect(companionResult).toEqual({
      id: 'operator-only',
      status: 'failed',
      message: 'Confirmation requires an independently authenticated operator resolution.',
      executed: false,
    });
    expect(operatorResult).toMatchObject({ status: 'approved', executed: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: 'operator-only',
        executed: true,
        resolver: { kind: 'operator', id: 'garden-admin' },
      }),
    ]);
  });
});

describe('ConfirmationQueue observer (companion relay seam)', () => {
  function buildQueue(nowRef: { value: number }) {
    const enqueued: string[] = [];
    const resolved: Array<{ id: string; status: string; resolvedAt: number }> = [];
    const queue = new ConfirmationQueue({
      now: () => nowRef.value,
      defaultExpiryMs: 1_000,
      observer: {
        onEnqueued: (entry) => enqueued.push(entry.id),
        onResolved: (outcome) => resolved.push({
          id: outcome.id,
          status: outcome.status,
          resolvedAt: outcome.resolvedAt,
        }),
      },
    });
    return { queue, enqueued, resolved };
  }

  const request = {
    method: 'fs.write',
    action: 'write',
    scope: '/tmp/observed.txt',
    params: { path: '/tmp/observed.txt' },
    companionReason: 'Observer test fixture',
  };

  it('notifies enqueue and approve resolution', async () => {
    const now = { value: 1_000 };
    const { queue, enqueued, resolved } = buildQueue(now);
    const entry = queue.enqueue(request, async () => undefined);
    expect(enqueued).toEqual([entry.id]);

    await queue.resolve({ id: entry.id, decision: 'approve' });
    expect(resolved).toEqual([{ id: entry.id, status: 'approved', resolvedAt: 1_000 }]);
  });

  it('notifies deny, execution failure, and expiry sweep outcomes', async () => {
    const now = { value: 1_000 };
    const { queue, resolved } = buildQueue(now);

    const denied = queue.enqueue(request, async () => undefined);
    await queue.resolve({ id: denied.id, decision: 'deny' });

    const failing = queue.enqueue(request, async () => {
      throw new Error('execution blocked');
    });
    await queue.resolve({ id: failing.id, decision: 'approve' });

    const expiring = queue.enqueue(request, async () => undefined);
    now.value = 10_000;
    queue.expirePending();

    expect(resolved.map((r) => [r.id, r.status])).toEqual([
      [denied.id, 'denied'],
      [failing.id, 'failed'],
      [expiring.id, 'expired'],
    ]);
  });

  it('does not notify resolution for unknown ids', async () => {
    const now = { value: 1_000 };
    const { queue, resolved } = buildQueue(now);
    const result = await queue.resolve({ id: 'missing', decision: 'approve' });
    expect(result.status).toBe('not_found');
    expect(resolved).toEqual([]);
  });
});
