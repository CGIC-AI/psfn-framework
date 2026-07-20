import { describe, expect, it, vi } from 'vitest';

import { createAgentLoopEgressReplySender } from './egress-reply-sender.js';
import type { EgressReplyDeliveryRequest } from '../../core/agent/arbiter/egress-lease-phase.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';

function makeResponse(content: string): AgentResponse {
  return { content } as AgentResponse;
}

function makeRequest(overrides: Partial<EgressReplyDeliveryRequest['trigger']> = {}): EgressReplyDeliveryRequest {
  return {
    reservation: {} as EgressReplyDeliveryRequest['reservation'],
    lease: {} as EgressReplyDeliveryRequest['lease'],
    appraisal: { action: 'reply', reasonCode: 'addressed', confidence: 0.9 },
    trigger: {
      channelId: 'discord:guild-1:general',
      channelType: 'discord',
      sourceMessageId: 'evt-1',
      authorId: 'human-1',
      authorName: 'Sam',
      content: 'hey companion',
      timestampMs: 1_000,
      ...overrides,
    },
    nowMs: 2_000,
  };
}

describe('createAgentLoopEgressReplySender', () => {
  it('generates via a synthetic terminal turn and delivers to the room channel', async () => {
    const generator = { handleMessage: vi.fn(async () => makeResponse('  Hi Sam!  ')) };
    const delivery = { send: vi.fn(async () => undefined) };
    const sender = createAgentLoopEgressReplySender({
      generator,
      delivery,
      companionName: 'Purrsephone',
    });

    const result = await sender.deliver(makeRequest());
    expect(result.outcome).toBe('delivered');

    // Generation runs on an INTERNAL terminal channel (no auto-delivery there).
    const genMessage = generator.handleMessage.mock.calls[0]?.[0];
    expect(genMessage?.channelType).toBe('terminal');
    expect(genMessage?.channelId).toContain('internal:egress-reply:');
    // The untrusted room text is datamarked into the prompt.
    expect(genMessage?.content).toContain('UNTRUSTED ROOM MESSAGE');
    expect(genMessage?.content).toContain('hey companion');
    // The trimmed reply is delivered to the REAL room channel.
    expect(delivery.send).toHaveBeenCalledWith('discord:guild-1:general', 'Hi Sam!');
  });

  it('reports a non-delivery (never sends empty) when the model declines', async () => {
    const generator = { handleMessage: vi.fn(async () => makeResponse('__no_reply__')) };
    const delivery = { send: vi.fn(async () => undefined) };
    const sender = createAgentLoopEgressReplySender({ generator, delivery, companionName: 'P' });
    const result = await sender.deliver(makeRequest());
    expect(result.outcome).toBe('failed');
    expect(result.detail).toBe('model_declined');
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('reports a non-delivery on an empty generation', async () => {
    const generator = { handleMessage: vi.fn(async () => makeResponse('   ')) };
    const delivery = { send: vi.fn(async () => undefined) };
    const sender = createAgentLoopEgressReplySender({ generator, delivery, companionName: 'P' });
    const result = await sender.deliver(makeRequest());
    expect(result.outcome).toBe('failed');
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('fails closed for a non-discord channel (no generation, no send)', async () => {
    const generator = { handleMessage: vi.fn(async () => makeResponse('hi')) };
    const delivery = { send: vi.fn(async () => undefined) };
    const sender = createAgentLoopEgressReplySender({ generator, delivery, companionName: 'P' });
    const result = await sender.deliver(makeRequest({ channelType: 'companion' }));
    expect(result.outcome).toBe('failed');
    expect(result.detail).toBe('unsupported_channel_type');
    expect(generator.handleMessage).not.toHaveBeenCalled();
    expect(delivery.send).not.toHaveBeenCalled();
  });
});
