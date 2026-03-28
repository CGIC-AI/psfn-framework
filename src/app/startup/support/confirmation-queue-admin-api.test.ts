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

  it('merges local and gateway confirmations and resolves local entries first', async () => {
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
          method: 'fs.write',
          action: 'write_file',
          scope: '/workspace',
          params: { path: 'gateway.txt' },
          companionReason: 'Need gateway approval',
          requestedAt: 2_000,
          expiresAt: 4_000,
        }],
      })),
      resolveConfirmationQueue: vi.fn(async () => ({
        id: 'gateway-confirmation',
        status: 'approved' as const,
        message: 'gateway resolved',
        executed: true,
      })),
    };

    const api = createGatewayConfirmationQueueAdminApi(gateway, localQueue);
    const listed = await api.listConfirmationQueue();
    const localResolved = await api.resolveConfirmationQueue({
      id: 'local-confirmation',
      decision: 'approve',
    });
    const gatewayResolved = await api.resolveConfirmationQueue({
      id: 'gateway-confirmation',
      decision: 'approve',
    });

    expect(listed.entries.map((entry) => entry.id)).toEqual([
      'local-confirmation',
      'gateway-confirmation',
    ]);
    expect(localResolved.id).toBe('local-confirmation');
    expect(gatewayResolved.id).toBe('gateway-confirmation');
    expect(gateway.resolveConfirmationQueue).toHaveBeenCalledTimes(1);
  });
});
