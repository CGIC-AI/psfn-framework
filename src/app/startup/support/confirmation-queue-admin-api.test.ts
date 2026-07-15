import { describe, expect, it, vi } from 'vitest';
import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import {
  createGatewayConfirmationQueueAdminApi,
  createLocalConfirmationQueueAdminApi,
} from './confirmation-queue-admin-api.js';

describe('confirmation queue admin api helpers', () => {
  it('wraps a local confirmation queue as the admin api', async () => {
    const queue = new ConfirmationQueue({
      now: () => 1_000,
      idFactory: () => 'local-confirmation',
    });
    queue.enqueue(
      {
        method: 'fs.write',
        action: 'write_file',
        scope: '/workspace',
        params: { path: 'note.txt' },
        companionReason: 'Need approval',
      },
      async () => undefined,
    );

    const api = createLocalConfirmationQueueAdminApi(queue);
    const listed = await api.listConfirmationQueue();

    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.id).toBe('local-confirmation');
  });

  it('merges local and gateway confirmations, resolves local entries, and fails closed on operator-owned entries', async () => {
    const localQueue = new ConfirmationQueue({
      now: () => 1_000,
      idFactory: () => 'local-confirmation',
    });
    localQueue.enqueue(
      {
        method: 'identity.update',
        action: 'update_identity',
        scope: 'character-card',
        params: { patch: { mood: 'focused' } },
        companionReason: 'Need local approval',
      },
      async () => undefined,
    );

    const gateway = {
      listConfirmationQueue: vi.fn(async () => ({
        entries: [{
          id: 'gateway-confirmation',
          method: 'kube.self_management',
          action: 'rollout_restart',
          scope: 'namespace/psfn',
          params: { release: 'psfn' },
          companionReason: 'Need gateway approval',
          resolutionAuthority: 'operator' as const,
          requestedAt: 2_000,
          expiresAt: 4_000,
        }],
      })),
    };

    const api = createGatewayConfirmationQueueAdminApi(gateway, localQueue);
    const listed = await api.listConfirmationQueue();
    const localResolved = await api.resolveConfirmationQueue({
      id: 'local-confirmation',
      decision: 'approve',
    });
    // Operator-owned gateway confirmations are never resolvable from the agent
    // surface — no operator credential can traverse the agent (x5rt.10). The
    // entry stays pending; only the operator process may resolve it.
    const gatewayResolved = await api.resolveConfirmationQueue({
      id: 'gateway-confirmation',
      decision: 'approve',
    });

    expect(listed.entries.map((entry) => entry.id)).toEqual([
      'local-confirmation',
      'gateway-confirmation',
    ]);
    expect(localResolved.id).toBe('local-confirmation');
    expect(localResolved.status).toBe('approved');
    expect(localResolved.executed).toBe(true);
    expect(gatewayResolved).toEqual({
      id: 'gateway-confirmation',
      status: 'not_found',
      message: 'Confirmation is not resolvable by the agent; operator authority is required.',
      executed: false,
    });
  });

  it('does not expose an auth parameter on the resolve surface', () => {
    const localQueue = new ConfirmationQueue({ idFactory: () => 'x' });
    const gateway = { listConfirmationQueue: vi.fn(async () => ({ entries: [] })) };
    const api = createGatewayConfirmationQueueAdminApi(gateway, localQueue);
    // The agent-hosted surface must not accept operator credential material:
    // resolveConfirmationQueue takes a single (params) argument only.
    expect(api.resolveConfirmationQueue.length).toBe(1);
  });
});
