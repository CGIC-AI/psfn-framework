import { describe, expect, it } from 'vitest';
import type { ChannelPromptRegistryPort } from '../../../channels/backplane/registry-port.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { resolveTaskKind } from './channel-routing-runtime.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;
const registry: ChannelPromptRegistryPort = {
  get: () => undefined,
};

function privateInitiationMessage(): SubstrateMessage {
  return {
    id: 'icp-initiation:33333333-3333-4333-8333-333333333333',
    channelId: CHANNEL,
    channelType: 'companion',
    authorId: 'system:icp-initiation',
    authorName: 'ICP Initiation',
    content: 'private scheduler trigger',
    timestamp: new Date(),
    isDirectMessage: true,
    routing: {
      source: 'companion',
      privateTurnTrigger: true,
      icpContinuationTaskKind: 'work',
      icpCorrelation: {
        conversationId: '44444444-4444-4444-8444-444444444444',
        rootInitiationId: '55555555-5555-4555-8555-555555555555',
        initiatedByCompanionId: LOCAL,
        localCompanionId: LOCAL,
        peerCompanionId: PEER,
        peerContactId: 'peer-contact',
        channelId: CHANNEL,
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7089',
        messageId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
        requestId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
        chargeLane: 'companion_social',
        surface: 'companion_dm',
        costPurpose: 'conversation_turn',
        costOriginStage: 'initiation',
        fatigueDecision: 'not_evaluated',
      },
    },
  };
}

describe('channel routing ICP continuation evidence', () => {
  it('accepts typed work evidence only on the bound private initiation turn', () => {
    expect(resolveTaskKind(privateInitiationMessage(), registry)).toBe('work');
  });

  it('rejects typed continuation evidence on an ordinary inbound message', () => {
    const message = privateInitiationMessage();
    message.authorId = PEER;
    message.routing = { ...message.routing, privateTurnTrigger: false };
    expect(() => resolveTaskKind(message, registry)).toThrow('bound private target turn');
  });

  it('rejects an invalid runtime continuation kind', () => {
    const message = privateInitiationMessage();
    if (!message.routing) throw new Error('test routing missing');
    message.routing.icpContinuationTaskKind = 'chat' as 'work';
    expect(() => resolveTaskKind(message, registry)).toThrow('task kind is invalid');
  });
});
