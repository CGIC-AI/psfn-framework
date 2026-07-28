import { describe, expect, it, vi } from 'vitest';
import type {
  ClarifyDeliverParams,
  ClarifyDeliverResult,
  PendingClarification,
} from '../protocol.js';
import type { ChannelOutboundDock } from '../../../channels/backplane/types.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerClarifyMethods } from './clarify.js';

const clarification: PendingClarification = {
  id: 'clar-1',
  question: 'Which one?',
  choices: ['A', 'B'],
};

function captureClarifyHandler(runtime: Partial<GatewayMethodRuntime>): (params: ClarifyDeliverParams) => Promise<unknown> {
  let captured: ((params: unknown) => Promise<unknown>) | undefined;
  const target = {
    addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
      if (name === 'clarify.deliver') captured = handler;
    },
  };
  const full = {
    ...runtime,
    target,
    audited: <P, R>(_method: string, handler: (params: P) => Promise<R>) => handler,
  } as unknown as GatewayMethodRuntime;
  registerClarifyMethods(full);
  if (!captured) throw new Error('clarify.deliver was not registered');
  return captured as (params: ClarifyDeliverParams) => Promise<unknown>;
}

function dockWithClarify(result: ClarifyDeliverResult): {
  dock: ChannelOutboundDock;
  deliver: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(async () => result);
  const dock = {
    id: 'test',
    outbound: {
      textChunkLimit: 2000,
      sendText: async () => undefined,
      deliverClarification: deliver,
    },
  } as unknown as ChannelOutboundDock;
  return { dock, deliver };
}

describe('clarify.deliver gateway method', () => {
  it('routes a discord clarification to the per-connection discord dock', async () => {
    const resolved: ClarifyDeliverResult = {
      status: 'resolved',
      channel: 'discord',
      target: 'chan-1',
      selection: { clarificationId: 'clar-1', selectedIndex: 0, selectedChoice: 'A' },
    };
    const { dock, deliver } = dockWithClarify(resolved);
    const handler = captureClarifyHandler({ discordAdapter: dock });

    const result = await handler({
      channel: 'discord', target: 'chan-1', clarification, timeoutMs: 5000, originatingUserId: 'author-1',
    });

    expect(result).toEqual(resolved);
    // The originating user is plumbed through so the dock can bind the answer.
    expect(deliver).toHaveBeenCalledWith(clarification, 'chan-1', 5000, 'author-1');
  });

  it('routes a telegram clarification to the telegram dock', async () => {
    const pending: ClarifyDeliverResult = { status: 'pending', channel: 'telegram', target: 'telegram:9' };
    const discord = dockWithClarify({ status: 'pending', channel: 'discord', target: 'x' });
    const telegram = dockWithClarify(pending);
    const handler = captureClarifyHandler({ discordAdapter: discord.dock, telegramDock: telegram.dock });

    const result = await handler({
      channel: 'telegram', target: 'telegram:9', clarification, timeoutMs: 5000, originatingUserId: 'tg-user-1',
    });

    expect(result).toEqual(pending);
    expect(telegram.deliver).toHaveBeenCalledWith(clarification, 'telegram:9', 5000, 'tg-user-1');
    expect(discord.deliver).not.toHaveBeenCalled();
  });

  it('fails closed when the requested channel is not wired', async () => {
    const discord = dockWithClarify({ status: 'pending', channel: 'discord', target: 'x' });
    // telegramDock absent
    const handler = captureClarifyHandler({ discordAdapter: discord.dock });

    await expect(
      handler({ channel: 'telegram', target: 'telegram:9', clarification, timeoutMs: 5000 }),
    ).rejects.toThrow('telegram is not wired');
  });
});
