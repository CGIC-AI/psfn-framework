import { describe, it, expect, vi } from 'vitest';
import { createNotifyOperatorTool, type NtfyNotifier } from './ntfy.js';
import { ExternalCommunicationRateLimiter } from '../capabilities/safeguards.js';
import { runWithRequestContext } from '../llm/request-context.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify_operator tool', () => {
  it('returns explicit success text when alert is sent', async () => {
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
});
