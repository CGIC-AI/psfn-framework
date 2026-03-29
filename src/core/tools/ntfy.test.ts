import { describe, it, expect, vi } from 'vitest';
import { createHttpNotificationPortFromEnv, createNotifyOperatorTool, type NotificationPort } from './ntfy.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify_operator tool', () => {
  it('returns explicit success text when alert is sent', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
        messageId: 'msg-1',
      }),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-1', {
      message: 'Discord gateway offline',
      title: 'Incident',
      priority: 5,
    });

    expect(resultText(result as any)).toContain('notify_operator: success');
    expect(resultText(result as any)).toContain('topic "ops"');
    expect(resultText(result as any)).toContain('id msg-1');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('returns explicit debounced text when duplicate is suppressed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'debounced',
        topic: 'ops',
      }),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-2', {
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify_operator: debounced');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('returns explicit failure text when notifier throws', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('ntfy request failed: 503 Service Unavailable')),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-3', {
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify_operator: failure');
    expect(resultText(result as any)).toContain('503 Service Unavailable');
    expect((result.details as any).isError).toBe(true);
  });

  it('fails fast when message is empty', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-4', {
      message: '   ',
    });

    expect(resultText(result as any)).toContain('notify_operator: failure');
    expect((result.details as any).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('enforces external communication rate limits', async () => {
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
    const tool = createNotifyOperatorTool(notifier, {
      rateLimiter: limiter,
      defaultChannel: 'discord',
    });

    const first = await tool.execute('call-5', { message: 'First alert' });
    expect(resultText(first as any)).toContain('notify_operator: success');

    const blocked = await tool.execute('call-6', { message: 'Second alert' });
    expect(resultText(blocked as any)).toContain('rate limit');
    expect((blocked.details as any).isError).toBe(true);
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000 + 1;
    const afterWindow = await tool.execute('call-7', { message: 'Third alert' });
    expect(resultText(afterWindow as any)).toContain('notify_operator: success');
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it('blocks scheduled/internal execution contexts to prevent heartbeat ntfy bleed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await runWithRequestContext(
      {
        callType: 'scheduled',
        channelId: 'internal:reflection:whisper',
        purpose: 'agent.turn.prompt',
      },
      async () => tool.execute('call-8', {
        message: 'Heartbeat alert',
      }),
    );

    expect(resultText(result as any)).toContain('notify_operator: blocked');
    expect((result.details as any).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('declares runtime wiring metadata for Garden health derivation', () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };

    const tool = createNotifyOperatorTool(notifier, { gatewayMode: true }) as {
      wiringMeta?: {
        requiredServices?: string[];
        requiredGatewayMethods?: string[];
        contextRestrictions?: {
          disallowInternal?: boolean;
          disallowScheduled?: boolean;
        };
      };
    };

    expect(tool.wiringMeta).toEqual({
      requiredGatewayMethods: ['notify.ntfy'],
      requiredServices: ['ntfy'],
      contextRestrictions: {
        disallowInternal: true,
        disallowScheduled: true,
      },
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

      await notifier.notify({ message: 'Operator alert' });

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
});
