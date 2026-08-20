import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('$lib/api/client', () => ({ apiPost: mocks.apiPost }));
vi.mock('$lib/cache/queue-cache', () => ({
  createQueuePageCache: () => ({
    load: vi.fn(),
    read: vi.fn(),
    revalidate: vi.fn(),
    remove: mocks.remove,
  }),
  isAdminConfirmationsData: vi.fn(),
}));

import { resolveConfirmation } from './confirmations';

describe('confirmation queue resolution cache coherence', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.remove.mockReset();
  });

  it('invalidates the pending queue after a terminal decision so it cannot blink back', async () => {
    const result = {
      ok: true,
      status: 'denied',
      message: 'Denied by operator.',
      executed: false,
    } as const;
    mocks.apiPost.mockResolvedValue(result);

    await expect(resolveConfirmation('confirmation-1', 'deny')).resolves.toEqual(result);

    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.apiPost).toHaveBeenCalledWith('/api/admin/confirmations/resolve', {
      id: 'confirmation-1',
      decision: 'deny',
      modifiedParams: undefined,
    });
  });

  it('retains the cached queue when the resolve request itself fails', async () => {
    mocks.apiPost.mockRejectedValue(new Error('connection lost'));

    await expect(resolveConfirmation('confirmation-1', 'approve'))
      .rejects.toThrow('connection lost');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
