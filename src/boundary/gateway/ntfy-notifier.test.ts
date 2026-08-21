import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { GatewayNtfyNotifier, notifyOperatorForPendingAction } from './ntfy-notifier.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gateway ntfy provider idempotency', () => {
  it('derives the canonical ntfy sequence id from the caller dedupe key', async () => {
    const fetchMock = vi.fn(async () => new Response('', {
      status: 200,
      headers: { 'x-message-id': 'provider-message-1' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new GatewayNtfyNotifier({
      baseUrl: 'https://ntfy.example.test',
      defaultTopic: 'operator-alerts',
      timeoutMs: 1_000,
      debounceWindowMs: 0,
    });

    const alert = {
      sender: {
        kind: 'system' as const,
        provenance: 'system.operator_alert.model_budget_threshold',
      },
      message: 'Budget threshold crossed',
      idempotencyKey: 'model-budget-alert-test-key',
    };

    await notifier.send(alert);
    await notifier.send(alert);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.example.test/operator-alerts',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Sequence-ID':
            'f769470f01667f3602212364430725d8fe308d3b0d3579c59eb3c81d3d35aa45',
        }),
      }),
    );
  });
});

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
