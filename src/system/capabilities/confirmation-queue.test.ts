import { describe, it, expect, vi } from 'vitest';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
} from './confirmation-queue.js';

describe('ConfirmationQueue', () => {
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
