import { describe, expect, it, vi } from 'vitest';
import {
  createNotifyDispatcher,
  createNotifyTool,
  type NotifyChannelSender,
  type NtfyNotifier,
} from './ntfy.js';
import { ExternalCommunicationRateLimiter } from '../capabilities/safeguards.js';
import { runWithRequestContext } from '../llm/request-context.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify tool', () => {
  it('returns explicit success text when a brief is sent', async () => {
    const notifier: NtfyNotifier = {
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
  });

  it('returns explicit debounced text when a duplicate brief is suppressed', async () => {
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
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

  it('blocks brief actions from scheduled/internal execution contexts', async () => {
    const notifier: NtfyNotifier = {
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
    const notifier: NtfyNotifier = {
      notify: vi.fn(),
    };
    const sender: NotifyChannelSender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
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
    expect(sender.send).toHaveBeenCalledWith({
      channel: 'discord',
      target: 'discord:ops-room',
      message: 'Background task completed.',
    });
  });

  it('fails closed when outbound delivery targets are missing or internal', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn(),
    };
    const sender: NotifyChannelSender = {
      send: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const missingChannel = await tool.execute('call-10a', {
      action: 'send',
      message: 'Background task completed.',
      delivery_target: 'discord:ops-room',
    });
    expect(resultText(missingChannel as any)).toContain('delivery_channel is required');

    const missingTarget = await tool.execute('call-10', {
      action: 'send',
      message: 'Background task completed.',
      delivery_channel: 'discord',
    });
    expect(resultText(missingTarget as any)).toContain('delivery_target is required');

    const internalTarget = await tool.execute('call-11', {
      action: 'send',
      message: 'Background task completed.',
      delivery_channel: 'discord',
      delivery_target: 'internal:heartbeat',
    });
    expect(resultText(internalTarget as any)).toContain('external channel');
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('sends approval requests through the configured operator discord channel', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn(),
    };
    const sender: NotifyChannelSender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
      operatorDiscordChannelId: 'discord:operator-room',
      operatorNtfyTopic: 'ops',
    }));

    const result = await tool.execute('call-12', {
      action: 'approval_request',
      approval_id: 'confirm-1',
      approval_method: 'git.apply_patch',
      approval_action: 'git.write',
      approval_scope: 'src/tools/ntfy.ts',
      approval_reason: 'Patch touches repo-owned runtime wiring.',
      approval_expires_at: 1_800_000_000_000,
    });

    expect(resultText(result as any)).toContain('notify: approval_request sent via discord');
    expect(sender.send).toHaveBeenCalledWith({
      channel: 'discord',
      target: 'discord:operator-room',
      message: expect.stringContaining('Approval required: git.apply_patch (git.write)'),
    });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('declares gateway wiring metadata for ntfy and discord delivery paths', () => {
    const notifier: NtfyNotifier = {
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
});
