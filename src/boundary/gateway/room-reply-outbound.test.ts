import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import { ExternalChannelAdapter } from '../../channels/external/adapter.js';
import { ExternalChannelMcpRoute } from '../../channels/external/mcp-route.js';
import {
  EXTERNAL_CHANNEL_TEST_COMPANION_ID,
  EXTERNAL_CHANNEL_TEST_LIMITS,
} from '../../test-support/external-channel-conformance.js';
import {
  createGatewayRoomReplyOutbound,
  resolveRoomReplyOutboundTargets,
  RoomReplyOutboundRefusedError,
} from './room-reply-outbound.js';

function stubDock(): ChannelOutboundDock & { outbound: { sendText: ReturnType<typeof vi.fn> } } {
  return fromAny({ id: 'telegram', outbound: { textChunkLimit: 4096, sendText: vi.fn(async () => undefined) } });
}

async function startedExternalAdapter(): Promise<ExternalChannelAdapter> {
  const adapter = new ExternalChannelAdapter({
    config: {
      instanceId: 'sms',
      label: 'SMS',
      companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      limits: EXTERNAL_CHANNEL_TEST_LIMITS,
    },
    token: 'sms-token',
    intakeScreening: null,
    log: { warn: () => undefined, error: () => undefined },
    reportRuntimeFailure: () => undefined,
  });
  adapter.onMessage(async () => { throw new Error('unused'); });
  void new ExternalChannelMcpRoute([adapter], []);
  await adapter.start();
  return adapter;
}

describe('gateway room-reply outbound (ze2fx)', () => {
  it('queues an external room reply for the bridge to pull', async () => {
    const adapter = await startedExternalAdapter();
    const outbound = createGatewayRoomReplyOutbound({
      multiCompanion: true,
      targets: resolveRoomReplyOutboundTargets({ multiCompanion: true, externalAdapters: [adapter] }),
    });
    await outbound.send({
      channelType: 'external',
      channelId: 'external:sms:room-1',
      content: 'happy to help',
      companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    });
    expect(adapter.pullOutbound({ protocolVersion: 1 }).messages).toMatchObject([
      { conversationId: 'room-1', text: 'happy to help' },
    ]);
    await adapter.stop();
  });

  it('routes a telegram room reply through the telegram dock', async () => {
    const telegram = stubDock();
    const outbound = createGatewayRoomReplyOutbound({
      multiCompanion: false,
      targets: resolveRoomReplyOutboundTargets({ multiCompanion: false, telegram, externalAdapters: [] }),
    });
    await outbound.send({ channelType: 'telegram', channelId: 'telegram:-100200', content: 'hi', companionId: undefined });
    expect(telegram.outbound.sendText).toHaveBeenCalledWith({ channelId: 'telegram:-100200' }, 'hi');
  });

  it.each([
    ['another companion owns the channel', { companionId: 'other-companion' }, 'channel_not_owned_by_companion'],
    ['the fleet call is unattributed', { companionId: undefined }, 'missing_companion_attribution'],
    ['no target owns the channel', { channelId: 'external:unknown:room-1' }, 'unknown_channel'],
  ])('refuses before sending when %s', async (_label, override, reasonCode) => {
    const adapter = await startedExternalAdapter();
    const outbound = createGatewayRoomReplyOutbound({
      multiCompanion: true,
      targets: resolveRoomReplyOutboundTargets({ multiCompanion: true, externalAdapters: [adapter] }),
    });
    const attempt = outbound.send({
      channelType: 'external',
      channelId: 'external:sms:room-1',
      content: 'x',
      companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      ...override,
    });
    await expect(attempt).rejects.toBeInstanceOf(RoomReplyOutboundRefusedError);
    await expect(attempt).rejects.toMatchObject({ reasonCode });
    expect(adapter.pullOutbound({ protocolVersion: 1 }).messages).toEqual([]);
    await adapter.stop();
  });

  it('leaves an unowned telegram surface out on a fleet gateway', () => {
    const targets = resolveRoomReplyOutboundTargets({
      multiCompanion: true,
      telegram: stubDock(),
      externalAdapters: [],
    });
    expect(targets).toEqual([]);
  });
});
