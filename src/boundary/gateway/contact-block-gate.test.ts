import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { createGatewayContactBlockGate } from './contact-block-gate.js';
import { wireGatewayChannelMessages } from './channel-surfaces.js';

const companionActor = { kind: 'companion' as const, id: 'companion' };

function baseMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    channelId: 'discord-dm-42',
    channelType: 'discord',
    authorId: '42',
    authorName: 'abuser',
    content: 'stop ignoring me',
    timestamp: new Date('2026-07-09T00:00:00.000Z'),
    isDirectMessage: true,
    ...over,
  };
}

describe('gateway contact block gate', () => {
  let dir: string;
  let blockList: ContactBlockListStore;
  let cogSecEvents: CogSecEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-gate-'));
    blockList = new ContactBlockListStore(join(dir, 'contact-block-list.json'));
    cogSecEvents = new CogSecEventStore(join(dir, 'cogsec-events.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function wire(blockGate: ReturnType<typeof createGatewayContactBlockGate>) {
    let discordHandler: ((message: any) => Promise<any>) | undefined;
    let telegramHandler: ((message: any) => Promise<any>) | undefined;
    const notifyChannelMessage = vi.fn();
    const requestAgentVoiceStream = vi.fn(async () => ({
      content: '', channelId: 'telegram', model: '', durationMs: 0,
    }));
    wireGatewayChannelMessages({
      discord: { onMessage: (h) => { discordHandler = h as any; } } as any,
      telegram: { onMessage: (h) => { telegramHandler = h as any; } } as any,
      gateway: { notifyChannelMessage, requestAgentVoiceStream } as any,
      serializeMessage: (m) => ({ ...m }),
      blockGate,
    });
    return { discordHandler: discordHandler!, telegramHandler: telegramHandler!, notifyChannelMessage, requestAgentVoiceStream };
  }

  it('drops a hard-blocked DM at the gateway so it never reaches the agent', async () => {
    blockList.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });
    const gate = createGatewayContactBlockGate({ blockList, cogSecEvents });
    const { discordHandler, notifyChannelMessage } = wire(gate);

    await discordHandler(baseMessage());

    // The gateway boundary: notifyChannelMessage is the RPC to the agent process.
    // A hard-blocked DM must never cross it.
    expect(notifyChannelMessage).not.toHaveBeenCalled();
    // Hard blocks stay silent — no operator event.
    expect(cogSecEvents.listEvents()).toHaveLength(0);
  });

  it('forwards a non-blocked DM to the agent', async () => {
    const gate = createGatewayContactBlockGate({ blockList, cogSecEvents });
    const { discordHandler, notifyChannelMessage } = wire(gate);

    await discordHandler(baseMessage({ authorId: '77' }));

    expect(notifyChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('drops a soft-blocked DM AND emits an operator-visible cogsec quarantine event', async () => {
    blockList.block({ channelType: 'discord', contactId: '42', mode: 'soft', actor: companionActor });
    const gate = createGatewayContactBlockGate({ blockList, cogSecEvents });
    const { discordHandler, notifyChannelMessage } = wire(gate);

    await discordHandler(baseMessage());

    expect(notifyChannelMessage).not.toHaveBeenCalled();
    const events = cogSecEvents.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('intake_firewall');
    expect(events[0]?.sourceChannelId).toBe('discord-dm-42');
    expect(events[0]?.safeAgentSummary).toContain('Soft-blocked');
  });

  it('observes (does not drop) a blocked group message and downgrades it to observe-only', async () => {
    blockList.block({ channelType: 'discord', contactId: '42', mode: 'hard', actor: companionActor });
    const gate = createGatewayContactBlockGate({ blockList, cogSecEvents });
    const { discordHandler, notifyChannelMessage } = wire(gate);

    await discordHandler(baseMessage({ isDirectMessage: false, channelId: 'guild-room' }));

    // Group room: forwarded (room context preserved) but as observe-only so the
    // companion ignores that author without disrupting everyone else.
    expect(notifyChannelMessage).toHaveBeenCalledTimes(1);
    const payload = notifyChannelMessage.mock.calls[0][2];
    expect(payload.message.routing.responseMode).toBe('observe');
  });

  it('drops a hard-blocked telegram DM before requestAgentVoiceStream', async () => {
    blockList.block({ channelType: 'telegram', contactId: 'tg-9', mode: 'hard', actor: companionActor });
    const gate = createGatewayContactBlockGate({ blockList, cogSecEvents });
    const { telegramHandler, requestAgentVoiceStream } = wire(gate);

    await telegramHandler(baseMessage({ channelType: 'telegram', authorId: 'tg-9', channelId: 'tg-dm' }));

    expect(requestAgentVoiceStream).not.toHaveBeenCalled();
  });
});
