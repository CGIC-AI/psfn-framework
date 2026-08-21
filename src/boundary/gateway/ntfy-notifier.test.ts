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
      idempotencyKey:
        '11111111-1111-4111-8111-111111111111:daily_budget_exceeded:2026-08-20',
    };

    await notifier.send(alert);
    await notifier.send(alert);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.example.test/operator-alerts',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Sequence-ID':
            '881eae7f9202c64ca3df210656c882b3e56129fb8e2336a5ae13b9f3c889a484',
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
