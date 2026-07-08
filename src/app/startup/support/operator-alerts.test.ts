import { describe, expect, it, vi } from 'vitest';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createPromptGenerationFailureAlertHandler,
  formatActiveMemoryRefreshFailureAlert,
  formatPromptGenerationFailureAlert,
  isPromptGenerationFailureAlertConfigured,
  type ActiveMemoryRefreshEvent,
} from './operator-alerts.js';
import type { StreamTerminalFailureEvent } from '../../../core/agent/stream-adapter.js';
import type { NotificationPort } from '../../../core/tools/ntfy.js';

function makeEvent(): StreamTerminalFailureEvent {
  return {
    purpose: 'chat',
    attempts: 2,
    candidate: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.5',
      maxTokens: 8192,
    },
    candidates: [
      {
        provider: 'openrouter',
        model: 'z-ai/glm-5',
        maxTokens: 8192,
      },
      {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
        maxTokens: 8192,
      },
    ],
    error: new Error('403 Key limit exceeded (total limit)'),
    correlation: {
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      purpose: 'agent.turn.prompt',
    },
    service: 'scheduled',
    process: 'agent.turn.prompt',
  };
}

describe('operator alerts', () => {
  it('formats stable prompt-generation failure alerts for ntfy delivery', () => {
    const text = formatPromptGenerationFailureAlert(makeEvent(), 'PSFN');

    expect(text).toContain('PSFN prompt generation failed after exhausting configured fallback.');
    expect(text).toContain('Service: scheduled');
    expect(text).toContain('Process: agent.turn.prompt');
    expect(text).toContain('Channel: internal:heartbeat');
    expect(text).toContain('Candidates: openrouter/z-ai/glm-5 -> openrouter/moonshotai/kimi-k2.5');
    expect(text).toContain('Error: 403 Key limit exceeded (total limit)');
  });

  it('sends a priority-5 ntfy alert for terminal prompt-generation failures', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
      }),
    };
    const handler = createPromptGenerationFailureAlertHandler(notifier, 'PSFN');

    await handler(makeEvent());

    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.prompt_generation_failure',
      },
      title: 'PSFN prompt generation failure',
      priority: 5,
      message: expect.stringContaining('Last tried: openrouter/moonshotai/kimi-k2.5'),
    }));
  });

  it('skips prompt-generation alerts when ntfy is not configured', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('ntfy is not configured')),
    };
    const handler = createPromptGenerationFailureAlertHandler(notifier, 'PSFN', {
      enabled: false,
    });

    await handler(makeEvent());

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('fails closed instead of inventing an operator alert identity', () => {
    expect(() => formatPromptGenerationFailureAlert(makeEvent(), '  ')).toThrow(
      'Missing companion name for operator alert: explicit identity is required',
    );
    expect(() => createPromptGenerationFailureAlertHandler({
      notify: vi.fn(),
    }, '')).toThrow('Missing companion name for operator alert: explicit identity is required');
  });

  it('requires both ntfy base URL and topic for prompt-generation alerts', () => {
    expect(isPromptGenerationFailureAlertConfigured({
      NTFY_BASE_URL: 'https://ntfy.local',
      NTFY_TOPIC: 'ops',
    })).toBe(true);
    expect(isPromptGenerationFailureAlertConfigured({
      NTFY_BASE_URL: 'https://ntfy.local',
    })).toBe(false);
    expect(isPromptGenerationFailureAlertConfigured({
      NTFY_TOPIC: 'ops',
    })).toBe(false);
  });
});

function makeFakeNotifier(): { notifier: NotificationPort; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => ({ status: 'sent' as const, topic: 'ops' }));
  return { notifier: { notify } as unknown as NotificationPort, notify };
}

function makeRefreshEvent(
  overrides: Partial<ActiveMemoryRefreshEvent> = {},
): ActiveMemoryRefreshEvent {
  return {
    channelId: 'ch1',
    key: 'contact:c1|session:ch1',
    phase: 'degraded',
    error: 'embedding backend unavailable',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('createActiveMemoryRefreshFailureAlertHandler', () => {
  it('fails closed on a missing or invalid threshold', () => {
    const { notifier } = makeFakeNotifier();
    for (const failureThreshold of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(() => createActiveMemoryRefreshFailureAlertHandler({
        notifier,
        companionName: 'PSFN',
        failureThreshold: failureThreshold as number | undefined,
      })).toThrow(/memoryRefreshFailureAlertThreshold/);
    }
  });

  it('alerts once when consecutive failures for a key cross the config-owned threshold', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 3,
    });

    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).not.toHaveBeenCalled();

    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: expect.objectContaining({
        kind: 'system',
        provenance: 'system.operator_alert.active_memory_refresh_failure',
      }),
      title: 'PSFN active-memory refresh failing',
      priority: 5,
      message: expect.stringContaining('Consecutive failures: 3'),
    }));

    // Continued failures for the same key do not re-alert until recovery.
    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tracks consecutive failures per active-context key', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 2,
    });

    await handler(makeRefreshEvent({ key: 'key-a' }));
    await handler(makeRefreshEvent({ key: 'key-b' }));
    expect(notify).not.toHaveBeenCalled();

    await handler(makeRefreshEvent({ key: 'key-a' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0]?.[0] as { message: string }).message).toContain('key-a');
  });

  it('resets the counter and re-arms the alert after a successful refresh', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 2,
    });

    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);

    await handler(makeRefreshEvent({ phase: 'ready' }));
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('retries delivery on the next failure when the notifier rejects', async () => {
    const notify = vi.fn(async () => {
      throw new Error('ntfy unreachable');
    });
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier: { notify } as unknown as NotificationPort,
      companionName: 'PSFN',
      failureThreshold: 1,
    });

    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);

    // Delivery failed, so the alerted state must not be faked: the next
    // degraded refresh retries the notification.
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('skips delivery but does not throw when ntfy is not configured', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 1,
      enabled: false,
    });

    await handler(makeRefreshEvent());
    expect(notify).not.toHaveBeenCalled();
  });

  it('formats the alert with key, channel, failure count, and last error', () => {
    const message = formatActiveMemoryRefreshFailureAlert(
      makeRefreshEvent({ key: 'contact:c1|session:ch1', channelId: 'discord:123' }),
      'PSFN',
      4,
    );
    expect(message).toContain('PSFN active-memory context refresh is failing persistently.');
    expect(message).toContain('Context key: contact:c1|session:ch1');
    expect(message).toContain('Channel: discord:123');
    expect(message).toContain('Consecutive failures: 4');
    expect(message).toContain('Last error: embedding backend unavailable');
  });
});
