import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import {
  resolveDiscordPrimaryUsers,
  resolveChannelIntakeScreening,
  wireGatewayChannelMessages,
  type WireGatewayChannelMessagesInput,
} from './channel-surfaces.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';

function createInput(): {
  input: WireGatewayChannelMessagesInput;
  discordHandler: ((message: any) => Promise<any>) | undefined;
  telegramHandler: ((message: any) => Promise<any>) | undefined;
} {
  let discordHandler: ((message: any) => Promise<any>) | undefined;
  let telegramHandler: ((message: any) => Promise<any>) | undefined;

  return {
    input: {
      discord: fromAny({
        onMessage: (handler) => {
          discordHandler = handler as (message: any) => Promise<any>;
        },
      }),
      telegram: fromAny({
        onMessage: (handler) => {
          telegramHandler = handler as (message: any) => Promise<any>;
        },
      }),
      gateway: fromAny({
        notifyChannelMessage: vi.fn(() => 1),
        requestAgentVoiceStream: vi.fn(async () => ({
          content: 'voice reply',
          channelId: 'telegram-channel',
          model: 'test-model',
          durationMs: 42,
          attachments: [{ kind: 'audio' }],
        })),
      }),
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
      discord: fromAny({ onMessage: sharedDiscordOnMessage }),
      discordAccounts: [
        { accountId: 'acct-a', adapter: fromAny(makeAdapter('acct-a')) },
        { accountId: 'acct-b', adapter: fromAny(makeAdapter('acct-b')) },
      ],
      gateway: fromAny({
        notifyChannelMessage,
        requestAgentVoiceStream: vi.fn(),
      }),
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

    const call = (fromAny(setup.input.gateway.notifyChannelMessage)).mock.calls[0];
    expect(call).toHaveLength(3);
  });
});

describe('gateway channel intake ownership', () => {
  const screeningService = (): IntakeScreeningService => ({
    mode: 'enforce',
    globalMode: 'strict',
    screen: async () => {
      throw new Error('screening invocation is outside this routing test');
    },
    screenSync: () => {
      throw new Error('screening invocation is outside this routing test');
    },
  });

  it('derives primary Discord authors only from exact companion owner-roster bindings', () => {
    const companionA = createCompanionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const companionB = createCompanionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const config = {
      fleetAuth: {
        provider: { kind: 'discord' },
        accountRoster: [
          {
            providerSubjectId: '123456789012345678',
            companionId: companionA,
            contactId: 'contact-owner-a',
            role: 'owner',
          },
          {
            providerSubjectId: '223456789012345678',
            companionId: companionA,
            contactId: 'contact-admin-a',
            role: 'admin',
          },
          {
            providerSubjectId: '323456789012345678',
            companionId: companionB,
            contactId: 'contact-owner-b',
            role: 'owner',
          },
        ],
      },
    } satisfies Parameters<typeof resolveDiscordPrimaryUsers>[0];

    expect(resolveDiscordPrimaryUsers(config, companionA)).toEqual([{
      userId: '123456789012345678',
      canonicalContactId: 'contact-owner-a',
    }]);
    expect(resolveDiscordPrimaryUsers(config, companionB)).toEqual([{
      userId: '323456789012345678',
      canonicalContactId: 'contact-owner-b',
    }]);
  });

  it('resolves each fleet surface to its exact companion service', () => {
    const companionA = createCompanionId(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'test companion A',
    );
    const companionB = createCompanionId(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'test companion B',
    );
    const screeningA = screeningService();
    const screeningB = screeningService();
    const screeningForCompanion = vi.fn((companionId: typeof companionA) => {
      if (companionId === companionA) return screeningA;
      if (companionId === companionB) return screeningB;
      throw new Error(`unknown companion ${companionId}`);
    });
    const routing = {
      multiCompanion: true,
      mode: 'strict' as const,
      singleton: null,
      forCompanion: screeningForCompanion,
    };

    expect(resolveChannelIntakeScreening(routing, companionA, 'discord account A'))
      .toBe(screeningA);
    expect(resolveChannelIntakeScreening(routing, companionB, 'discord account B'))
      .toBe(screeningB);
    expect(screeningForCompanion).toHaveBeenCalledWith(companionA);
    expect(screeningForCompanion).toHaveBeenCalledWith(companionB);
  });

  it('fails closed when fleet routing lacks an owner resolver or matching mode', () => {
    const companion = createCompanionId(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'test companion',
    );
    expect(() => resolveChannelIntakeScreening({
      multiCompanion: true,
      mode: 'strict',
      singleton: null,
    }, companion, 'discord')).toThrow(/no companion-owned intake screening resolver/u);
    expect(() => resolveChannelIntakeScreening({
      multiCompanion: true,
      mode: 'strict',
      singleton: null,
      forCompanion: () => null,
    }, companion, 'discord')).toThrow(/mode=enforce has no matching service/u);
  });
});
