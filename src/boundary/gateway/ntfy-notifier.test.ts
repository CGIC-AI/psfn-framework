import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { notifyOperatorForPendingAction } from './ntfy-notifier.js';

describe('pending approval notifications', () => {
  it('reports an unreachable sink instead of silently accepting a log-only alert', async () => {
    await expect(notifyOperatorForPendingAction({
      entry: fromAny({
        id: 'confirmation-1',
        method: 'git.commit',
        action: 'commit',
        scope: 'repository',
        companionReason: 'Apply verified change',
        expiresAt: Date.now() + 60_000,
      }),
      discordAdapter: fromAny({
        outbound: { sendText: async () => undefined },
      }),
    })).rejects.toThrow(/no reachable operator notification sink/u);
  });
});
