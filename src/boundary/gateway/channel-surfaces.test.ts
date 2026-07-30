import { describe, expect, it, vi } from 'vitest';
import {
  loadGatewayChannelSurfaces,
  stopGatewayChannelSurfaces,
  wireGatewayChannelMessages,
  type WireGatewayChannelMessagesInput,
} from './channel-surfaces.js';
import { EventBus } from '../../shared/event-bus.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

function createInput(): {
  input: WireGatewayChannelMessagesInput;
  discordHandler: ((message: any) => Promise<any>) | undefined;
  telegramHandler: ((message: any) => Promise<any>) | undefined;
} {
  let discordHandler: ((message: any) => Promise<any>) | undefined;
  let telegramHandler: ((message: any) => Promise<any>) | undefined;

  return {
    input: {
      discord: {
        onMessage: (handler) => {
          discordHandler = handler as (message: any) => Promise<any>;
        },
      } as any,
      telegram: {
        onMessage: (handler) => {
          telegramHandler = handler as (message: any) => Promise<any>;
        },
      } as any,
      gateway: {
        notifyChannelMessage: vi.fn(() => 1),
        requestAgentVoiceStream: vi.fn(async () => ({
          content: 'voice reply',
          channelId: 'telegram-channel',
          model: 'test-model',
          durationMs: 42,
          attachments: [{ kind: 'audio' }],
        })),
      } as any,
      serializeMessage: (message) => ({ ...message, serialized: true }),
    },
    get discordHandler() {
      return discordHandler;
    },
    get telegramHandler() {
      return telegramHandler;
    },
  };
}

describe('wireGatewayChannelMessages', () => {
  it('forwards Discord inbound messages and returns an explicit non-delivery acknowledgement', async () => {
    const setup = createInput();

    wireGatewayChannelMessages(setup.input);

    const response = await setup.discordHandler?.({
      channelId: 'discord-channel',
      content: 'hello',
      timestamp: new Date('2026-03-28T00:00:00.000Z'),
    });

    expect(setup.input.gateway.notifyChannelMessage).toHaveBeenCalledWith('discord', 'discord.message', {
      message: expect.objectContaining({
        channelId: 'discord-channel',
        serialized: true,
      }),
    });
    expect(response).toEqual({
      content: '',
      channelId: 'discord-channel',
      metadata: {
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        notificationAck: {
          schemaVersion: 1,
          disposition: 'notification_ack',
          outcome: 'forwarded_to_agent',
        },
      },
    });
  });

  it('does not acknowledge forwarding when the gateway delivers to zero agents', async () => {
    const setup = createInput();
    vi.mocked(setup.input.gateway.notifyChannelMessage).mockReturnValue(0);

    wireGatewayChannelMessages(setup.input);

    await expect(setup.discordHandler?.({
      channelId: 'discord-channel',
      content: 'hello',
      timestamp: new Date('2026-03-28T00:00:00.000Z'),
    })).rejects.toThrow('Discord inbound notification reached zero eligible agents');
  });

  it('routes telegram inbound messages through requestAgentVoiceStream', async () => {
    const setup = createInput();

    wireGatewayChannelMessages(setup.input);

    const response = await setup.telegramHandler?.({
      channelId: 'telegram-channel',
      content: 'ping',
    });

    expect(setup.input.gateway.requestAgentVoiceStream).toHaveBeenCalledWith({
      channelId: 'telegram-channel',
      content: 'ping',
    });
    expect(response).toEqual({
      content: 'voice reply',
      channelId: 'telegram-channel',
      attachments: [{ kind: 'audio' }],
      metadata: {
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 42,
      },
    });
  });
});

describe('wireGatewayChannelMessages multi-account discord (W1-P2)', () => {
  it('wires each account adapter with its own accountId and skips the shared wiring', async () => {
    const handlers = new Map<string, (message: any) => Promise<any>>();
    const makeAdapter = (key: string) => ({
      onMessage: (handler: any) => {
        handlers.set(key, handler);
      },
    });

    const sharedDiscordOnMessage = vi.fn();
    const notifyChannelMessage = vi.fn(() => 1);
    wireGatewayChannelMessages({
      discord: { onMessage: sharedDiscordOnMessage } as any,
      discordAccounts: [
        { accountId: 'acct-a', adapter: makeAdapter('acct-a') as any },
        { accountId: 'acct-b', adapter: makeAdapter('acct-b') as any },
      ],
      gateway: {
        notifyChannelMessage,
        requestAgentVoiceStream: vi.fn(),
      } as any,
      serializeMessage: (message) => ({ ...message, serialized: true }),
    });

    // The primary adapter is part of discordAccounts; it must not be wired twice.
    expect(sharedDiscordOnMessage).not.toHaveBeenCalled();

    await handlers.get('acct-a')?.({ channelId: 'ch-1', content: 'from account a' });
    expect(notifyChannelMessage).toHaveBeenCalledWith(
      'discord',
      'discord.message',
      { message: expect.objectContaining({ channelId: 'ch-1', serialized: true }) },
      'acct-a',
    );

    await handlers.get('acct-b')?.({ channelId: 'ch-2', content: 'from account b' });
    expect(notifyChannelMessage).toHaveBeenLastCalledWith(
      'discord',
      'discord.message',
      { message: expect.objectContaining({ channelId: 'ch-2', serialized: true }) },
      'acct-b',
    );
    expect(notifyChannelMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the single-account call shape without a trailing accountId (parity)', async () => {
    const setup = createInput();
    wireGatewayChannelMessages(setup.input);

    await setup.discordHandler?.({ channelId: 'ch-3', content: 'single mode' });

    const call = (setup.input.gateway.notifyChannelMessage as any).mock.calls[0];
    expect(call).toHaveLength(3);
  });
});

describe('loadGatewayChannelSurfaces fleet intake ownership', () => {
  it('injects each multi-account adapter with its owning companion screening service', async () => {
    const companionA = createCompanionId(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'test companion A',
    );
    const companionB = createCompanionId(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'test companion B',
    );
    const screeningA = { mode: 'enforce', screen: vi.fn() };
    const screeningB = { mode: 'enforce', screen: vi.fn() };
    const screeningForCompanion = vi.fn((companionId: string) => {
      if (companionId === companionA) return screeningA;
      if (companionId === companionB) return screeningB;
      throw new Error(`unknown companion ${companionId}`);
    });
    const bootstrap = {
      workspaceRoot: '/single-workspace-must-not-be-used',
      server: {
        multiCompanion: {
          enabled: true,
          personalWorkspaceByCompanionId: {
            [companionA]: '/workspaces/a',
            [companionB]: '/workspaces/b',
          },
        },
      },
      channelsConfig: {
        discord: {
          heartbeatChannelId: '',
          allowedBotUserIds: [],
          groupMemory: {},
          accounts: [
            {
              accountId: 'account-a',
              companionId: companionA,
              tokenEnvVar: 'DISCORD_A',
              token: 'token-a',
              heartbeatChannelId: '',
              allowedBotUserIds: [],
              groupMemory: {},
            },
            {
              accountId: 'account-b',
              companionId: companionB,
              tokenEnvVar: 'DISCORD_B',
              token: 'token-b',
              heartbeatChannelId: '',
              allowedBotUserIds: [],
              groupMemory: {},
            },
          ],
        },
        telegram: {
          enabled: false,
          token: '',
          allowedUsers: [],
          mode: 'polling',
          pollIntervalMs: 1_000,
          webhook: { url: '', secret: '', host: '', port: 1, path: '' },
          companionId: companionB,
        },
      },
    };

    const surfaces = await loadGatewayChannelSurfaces({
      config: {
        discordBackfillOnStartup: false,
        sttProvider: 'disabled',
        ttsProvider: 'disabled',
      } as any,
      bootstrap: bootstrap as any,
      eventBus: new EventBus(),
      eligibilityGate: undefined as any,
      intakeScreening: null,
      intakeScreeningForCompanion: screeningForCompanion as any,
      log: { error: vi.fn(), warn: vi.fn() },
    });

    expect((surfaces.discordAccounts?.[0]?.adapter as any).intakeScreening).toBe(screeningA);
    expect((surfaces.discordAccounts?.[1]?.adapter as any).intakeScreening).toBe(screeningB);
    expect(screeningForCompanion).toHaveBeenCalledWith(companionA);
    expect(screeningForCompanion).toHaveBeenCalledWith(companionB);

    await stopGatewayChannelSurfaces(surfaces);
  });
});
