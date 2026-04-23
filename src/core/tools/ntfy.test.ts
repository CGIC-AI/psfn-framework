import { describe, it, expect, vi } from 'vitest';
import {
  createGatewayDiscordNotifySender,
  createHttpNotificationPortFromEnv,
  createNotifyDispatcher,
  createNotifyTool,
} from './ntfy.js';
import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

const companionBriefSender = {
  kind: 'companion',
  provenance: 'companion.notify.brief',
} as const;
const systemApprovalSender = {
  kind: 'system',
  provenance: 'system.approval.request',
} as const;

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify tool', () => {
  it('returns explicit success text when a brief is sent', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
        messageId: 'msg-1',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-1', {
      action: 'brief',
      message: 'Discord gateway offline',
      title: 'Incident',
      priority: 5,
    });

    expect(resultText(result as any)).toContain('notify: brief sent via ntfy');
    expect(resultText(result as any)).toContain('topic "ops"');
    expect(resultText(result as any)).toContain('id msg-1');
    expect((result.details as any).isError).toBeUndefined();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: companionBriefSender,
    }));
  });

  it('returns explicit debounced text when a duplicate brief is suppressed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'debounced',
        topic: 'ops',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-2', {
      action: 'brief',
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify: brief debounced');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('returns explicit failure text when brief delivery throws', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('ntfy request failed: 503 Service Unavailable')),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-3', {
      action: 'brief',
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify: failure');
    expect(resultText(result as any)).toContain('503 Service Unavailable');
    expect((result.details as any).isError).toBe(true);
  });

  it('fails fast when brief message is empty', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-4', {
      action: 'brief',
      message: '   ',
    });

    expect(resultText(result as any)).toContain('notify: failure');
    expect((result.details as any).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('enforces brief safeguard rate limits', async () => {
    let now = 1_000;
    const limiter = new ExternalCommunicationRateLimiter({
      now: () => now,
      discordPerHour: 1,
      emailPerHour: 1,
    });
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      rateLimiter: limiter,
      defaultBudgetChannel: 'discord',
    }));

    const first = await tool.execute('call-5', { action: 'brief', message: 'First alert' });
    expect(resultText(first as any)).toContain('notify: brief sent');

    const blocked = await tool.execute('call-6', { action: 'brief', message: 'Second alert' });
    expect(resultText(blocked as any)).toContain('rate limit');
    expect((blocked.details as any).isError).toBe(true);
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000 + 1;
    const afterWindow = await tool.execute('call-7', { action: 'brief', message: 'Third alert' });
    expect(resultText(afterWindow as any)).toContain('notify: brief sent');
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it('blocks scheduled/internal execution contexts to prevent heartbeat ntfy bleed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await runWithRequestContext(
      {
        callType: 'scheduled',
        channelId: 'internal:reflection:whisper',
        purpose: 'agent.turn.prompt',
      },
      async () => tool.execute('call-8', {
        action: 'brief',
        message: 'Heartbeat alert',
      }),
    );

    expect(resultText(result as any)).toContain('notify: blocked');
    expect((result.details as any).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('sends lightweight outbound notifications through explicit discord delivery targets', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const sender = createGatewayDiscordNotifySender({
      discordSend: vi.fn().mockResolvedValue(undefined),
    });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await tool.execute('call-9', {
      action: 'send',
      message: 'Background task completed.',
      delivery_channel: 'discord',
      delivery_target: 'discord:ops-room',
    });

    expect(resultText(result as any)).toContain('notify: send sent via discord');
  });

  it('declares runtime wiring metadata for Garden health derivation', () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };

    const tool = createNotifyTool(
      createNotifyDispatcher({ briefNotifier: notifier }),
      { gatewayMode: true },
    ) as {
      wiringMeta?: {
        requiredServices?: string[];
        requiredGatewayMethods?: string[];
      };
    };

    expect(tool.wiringMeta).toEqual({
      requiredGatewayMethods: ['discord.send', 'notify.ntfy'],
      requiredServices: ['ntfy'],
    });
  });

  it('resolves the ntfy token through the credential vault when constructing the notifier from env', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => null,
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const notifier = createHttpNotificationPortFromEnv(
        {
          NTFY_BASE_URL: 'https://ntfy.local',
          NTFY_TOPIC: 'ops',
        },
        {
          resolveOptional(reference) {
            return reference.envName === 'NTFY_TOKEN' ? 'vault-token' : undefined;
          },
          resolveRequired(reference, description) {
            const value = this.resolveOptional(reference);
            if (value) return value;
            throw new Error(`${description} is not configured`);
          },
          has(reference) {
            return this.resolveOptional(reference) !== undefined;
          },
        },
      );

      await notifier.notify({
        sender: systemApprovalSender,
        message: 'Operator alert',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://ntfy.local/ops',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer vault-token',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when the sender provenance does not match the sender kind', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const notifier = createHttpNotificationPortFromEnv({
        NTFY_BASE_URL: 'https://ntfy.local',
        NTFY_TOPIC: 'ops',
      });

      await expect(notifier.notify({
        sender: {
          kind: 'system',
          provenance: 'companion.notify.brief',
        },
        message: 'Operator alert',
      })).rejects.toThrow('notify sender provenance must start with "system."');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
