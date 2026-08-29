import { describe, expect, it, vi } from 'vitest';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import { resolveOperatorAlertSinkConfiguration } from '../../shared/contracts/operator-alerting.js';
import type { NotifyNtfyParams } from './protocol.js';
import { GatewayOperatorAlertDispatcher } from './operator-alert-dispatcher.js';

const ALERT: NotifyNtfyParams = {
  sender: {
    kind: 'system',
    provenance: 'system.operator_alert.backup_failure',
  },
  title: 'Backup failed',
  message: 'pg_dump exited 1',
  priority: 5,
};

function outboundDock(id: string, sendText = vi.fn(async () => {})): {
  dock: ChannelOutboundDock;
  sendText: typeof sendText;
} {
  return {
    dock: {
      id,
      outbound: {
        textChunkLimit: 4_096,
        sendText,
      },
    },
    sendText,
  };
}

const telegramDock = (sendText = vi.fn(async () => {})) => outboundDock('telegram', sendText);
const discordDock = (sendText = vi.fn(async () => {})) => outboundDock('discord', sendText);

describe('GatewayOperatorAlertDispatcher', () => {
  it('attempts ntfy and Telegram when both sinks are configured', async () => {
    const ntfySend = vi.fn(async () => ({ status: 'sent' as const, topic: 'ops' }));
    const telegram = telegramDock();
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => true,
        send: ntfySend,
      },
      telegramDock: telegram.dock,
      telegramChatId: '-100123',
    });

    const result = await dispatcher.dispatch(ALERT);

    expect(ntfySend).toHaveBeenCalledWith(ALERT);
    expect(telegram.sendText).toHaveBeenCalledWith(
      { channelId: 'telegram:-100123' },
      'Backup failed\n\npg\\_dump exited 1',
    );
    expect(result.deliveries).toEqual([
      { sink: 'ntfy', status: 'sent', target: 'ops' },
      { sink: 'telegram', status: 'sent', target: 'telegram:-100123' },
    ]);
  });

  it('still delivers to Telegram and logs the ntfy failure', async () => {
    const telegram = telegramDock();
    const logger = { error: vi.fn() };
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => true,
        send: vi.fn(async () => {
          throw new Error('ntfy unavailable');
        }),
      },
      telegramDock: telegram.dock,
      telegramChatId: '42',
      logger,
    });

    const result = await dispatcher.dispatch(ALERT);

    expect(telegram.sendText).toHaveBeenCalledOnce();
    expect(result.deliveries).toEqual([
      { sink: 'ntfy', status: 'failed', error: 'ntfy unavailable' },
      { sink: 'telegram', status: 'sent', target: 'telegram:42' },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      'Operator alert sink delivery failed',
      expect.objectContaining({ sink: 'ntfy', error: 'ntfy unavailable' }),
    );
  });

  it('starts Telegram delivery without waiting for an unavailable ntfy sink', async () => {
    let rejectNtfy!: (error: Error) => void;
    const ntfyPending = new Promise<never>((_resolve, reject) => {
      rejectNtfy = reject;
    });
    const telegram = telegramDock();
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => true,
        send: vi.fn(() => ntfyPending),
      },
      telegramDock: telegram.dock,
      telegramChatId: '42',
      logger: { error: vi.fn() },
    });

    const dispatch = dispatcher.dispatch(ALERT);
    await vi.waitFor(() => expect(telegram.sendText).toHaveBeenCalledOnce());
    rejectNtfy(new Error('ntfy timed out'));

    await expect(dispatch).resolves.toEqual({
      deliveries: [
        { sink: 'ntfy', status: 'failed', error: 'ntfy timed out' },
        { sink: 'telegram', status: 'sent', target: 'telegram:42' },
      ],
    });
  });

  it('attempts ntfy even when Telegram fails and rejects only when every sink fails', async () => {
    const ntfySend = vi.fn(async () => {
      throw new Error('ntfy unavailable');
    });
    const telegram = telegramDock(vi.fn(async () => {
      throw new Error('telegram unavailable');
    }));
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: { isConfigured: () => true, send: ntfySend },
      telegramDock: telegram.dock,
      telegramChatId: '42',
      logger: { error: vi.fn() },
    });

    await expect(dispatcher.dispatch(ALERT)).rejects.toThrow(
      'Operator alert delivery failed for every configured sink',
    );
    expect(ntfySend).toHaveBeenCalledOnce();
    expect(telegram.sendText).toHaveBeenCalledOnce();
  });

  it('returns a typed unconfigured outcome when no operator alert sink is configured', async () => {
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => false,
        send: vi.fn(),
      },
    });

    await expect(dispatcher.dispatch(ALERT)).resolves.toEqual({
      outcome: 'unconfigured',
      deliveries: [],
      warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
    });
  });

  it('delivers through an explicitly designated Discord-only sink', async () => {
    const discord = discordDock();
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: { isConfigured: () => false, send: vi.fn() },
      discordDock: discord.dock,
      discordChannelId: '987654321098765432',
    });

    await expect(dispatcher.dispatch(ALERT)).resolves.toEqual({
      deliveries: [{
        sink: 'discord',
        status: 'sent',
        target: 'discord:987654321098765432',
      }],
    });
    expect(discord.sendText).toHaveBeenCalledWith(
      { channelId: 'discord:987654321098765432' },
      '**Backup failed**\n\npg_dump exited 1',
    );
  });

  it('starts every explicit provider concurrently and preserves partial failures', async () => {
    let rejectNtfy!: (error: Error) => void;
    const ntfyPending = new Promise<never>((_resolve, reject) => {
      rejectNtfy = reject;
    });
    const telegram = telegramDock();
    const discord = discordDock();
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: { isConfigured: () => true, send: vi.fn(() => ntfyPending) },
      telegramDock: telegram.dock,
      telegramChatId: '42',
      discordDock: discord.dock,
      discordChannelId: '987654321098765432',
      logger: { error: vi.fn() },
    });

    const pending = dispatcher.dispatch(ALERT);
    await vi.waitFor(() => {
      expect(telegram.sendText).toHaveBeenCalledOnce();
      expect(discord.sendText).toHaveBeenCalledOnce();
    });
    rejectNtfy(new Error('ntfy unavailable'));

    await expect(pending).resolves.toEqual({
      deliveries: [
        { sink: 'ntfy', status: 'failed', error: 'ntfy unavailable' },
        { sink: 'telegram', status: 'sent', target: 'telegram:42' },
        { sink: 'discord', status: 'sent', target: 'discord:987654321098765432' },
      ],
    });
  });

  it('delivers keyed budget alerts to a configured Telegram-only sink', async () => {
    const telegram = telegramDock();
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => false,
        send: vi.fn(),
      },
      telegramDock: telegram.dock,
      telegramChatId: '42',
      logger: { error: vi.fn() },
    });

    await expect(dispatcher.dispatch({
      ...ALERT,
      idempotencyKey: 'model-budget-alert-test-key',
    })).resolves.toEqual({
      deliveries: [{ sink: 'telegram', status: 'sent', target: 'telegram:42' }],
    });
    expect(telegram.sendText).toHaveBeenCalledWith(
      { channelId: 'telegram:42' },
      'Backup failed\n\npg\\_dump exited 1',
    );
  });

  it('rejects companion-authored traffic on the system-only alert route', async () => {
    const dispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: {
        isConfigured: () => true,
        send: vi.fn(),
      },
    });

    await expect(dispatcher.dispatch({
      ...ALERT,
      sender: {
        kind: 'companion',
        provenance: 'companion.tool.notify',
      },
    })).rejects.toThrow('notify.operator accepts only system-derived notifications');
  });
});

describe('resolveOperatorAlertSinkConfiguration', () => {
  it('reports a loud degraded posture for zero sinks', () => {
    expect(resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: false,
      telegramEnabled: false,
      telegramChatId: '',
      discordEnabled: false,
      discordChannelId: '',
    })).toEqual({
      configuredSinks: [],
      status: 'unconfigured',
      warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
    });
  });

  it('does not count an operator chat id when the Telegram adapter is disabled', () => {
    expect(resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: false,
      telegramEnabled: false,
      telegramChatId: '42',
      discordEnabled: false,
      discordChannelId: '',
    }).status).toBe('unconfigured');
  });

  it('only reports fully configured sinks', () => {
    expect(resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: true,
      telegramEnabled: true,
      telegramChatId: ' 42 ',
      discordEnabled: true,
      discordChannelId: ' 987654321098765432 ',
    })).toEqual({
      configuredSinks: ['ntfy', 'telegram', 'discord'],
      status: 'configured',
      warning: null,
    });
  });

  it('does not treat an ordinary Discord adapter as an implicit alert sink', () => {
    expect(resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: false,
      telegramEnabled: false,
      discordEnabled: true,
    }).status).toBe('unconfigured');
  });
});
