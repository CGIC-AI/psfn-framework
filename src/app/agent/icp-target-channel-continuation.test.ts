import { describe, expect, it, vi } from 'vitest';

import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { IcpDeliveryObservation } from '../../core/session/icp-delivery-recovery.js';
import type { IcpDyadContinuationAuthorization } from '../../boundary/gateway/icp-autonomy-contract.js';
import {
  createIcpTargetChannelContinuation,
} from './icp-target-channel-continuation.js';

const LOCAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DYAD = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;

const authorization: IcpDyadContinuationAuthorization = {
  dyadId: DYAD,
  deliveryId: DELIVERY,
  peerCompanionId: PEER,
  channelId: CHANNEL,
  episode: {
    conversationId: CONVERSATION,
    channelId: CHANNEL,
    participantCompanionIds: [LOCAL, PEER],
    rootInitiationId: DELIVERY,
    initiatedByCompanionId: LOCAL,
    initiationSource: 'foreground',
    provenanceRef: `icp-prov:${DELIVERY}`,
    openedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    status: 'invited',
    revision: 1,
  },
};

function responseFor(message: SubstrateMessage, content: string): AgentResponse {
  const correlation = message.routing?.icpCorrelation!;
  return {
    content,
    channelId: CHANNEL,
    metadata: {
      model: 'deterministic-test-model',
      inputTokens: 4,
      outputTokens: 3,
      durationMs: 2,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      icpCorrelation: correlation,
    } as AgentResponse['metadata'],
  };
}

function harness(input: {
  content?: string;
  recorded?: { content: string; correlation: any; recoveryResponse: AgentResponse } | null;
  observation?: IcpDeliveryObservation | null;
  sendError?: Error;
} = {}) {
  const order: string[] = [];
  const observations: IcpDeliveryObservation[] = [];
  const sendContinuation = vi.fn(async () => {
    order.push('transport');
    if (input.sendError) throw input.sendError;
    return { messageId: 'companion-continuation-delivery', deliveredTo: [PEER], duplicate: false };
  });
  const recordContinuationOutcome = vi.fn(async () => undefined);
  const target = createIcpTargetChannelContinuation({
    localCompanionId: LOCAL,
    agent: {
      handleMessage: async (message, lifecycle) => {
        order.push(lifecycle.recoveredResponse ? 'resume-turn' : 'commit-turn');
        const response = lifecycle.recoveredResponse ?? responseFor(message, input.content ?? 'Hello again.');
        await lifecycle.finalizeDelivery(response);
        return response;
      },
      findRecordedIcpInitiation: async () => input.recorded ?? null,
      findIcpDeliveryObservation: async () => input.observation ?? null,
      recordIcpDeliveryObservation: async observation => {
        observations.push(observation);
      },
    },
    gateway: { sendContinuation, recordContinuationOutcome },
  });
  return { target, order, observations, sendContinuation, recordContinuationOutcome };
}

describe('ICP target-channel dyad continuation', () => {
  it('commits an ordinary target-channel turn before asynchronous transport', async () => {
    const test = harness();
    await expect(test.target.continueDyad({
      authorization,
      peerContactId: 'peer-contact',
      privateIntent: 'Check in without presuming a reply.',
    })).resolves.toEqual({ disposition: 'delivered' });

    expect(test.order).toEqual(['commit-turn', 'transport']);
    expect(test.sendContinuation).toHaveBeenCalledWith(expect.objectContaining({
      authorization,
      content: 'Hello again.',
    }));
    expect(test.sendContinuation.mock.calls[0]?.[0]).not.toHaveProperty('privateIntent');
    expect(test.observations.at(-1)).toMatchObject({
      status: 'delivered',
      turnCompleted: true,
      gatewayMessageId: 'companion-continuation-delivery',
    });
  });

  it('durably distinguishes a companion decline without transporting or awaiting a peer', async () => {
    const test = harness({ content: '' });
    await expect(test.target.continueDyad({
      authorization,
      peerContactId: 'peer-contact',
      privateIntent: 'Decide whether to say anything.',
    })).resolves.toEqual({ disposition: 'suppressed' });

    expect(test.sendContinuation).not.toHaveBeenCalled();
    expect(test.recordContinuationOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'suppressed',
      reasonCode: 'conversation_ended',
    }));
    expect(test.observations.at(-1)).toMatchObject({ status: 'suppressed', turnCompleted: true });
  });

  it('recovers a committed turn after transport failure without re-authoring it', async () => {
    const first = harness({ sendError: new Error('route unavailable') });
    await expect(first.target.continueDyad({
      authorization,
      peerContactId: 'peer-contact',
      privateIntent: 'Try a gentle greeting.',
    })).rejects.toThrow('route unavailable');
    const failed = first.observations.at(-1)!;
    const recoveryResponse = failed.recoveryResponse!;
    const correlation = recoveryResponse.metadata.icpCorrelation!;

    const restarted = harness({
      recorded: { content: recoveryResponse.content, correlation, recoveryResponse },
      observation: failed,
    });
    await expect(restarted.target.continueDyad({
      authorization,
      peerContactId: 'peer-contact',
      privateIntent: 'Try a gentle greeting.',
    })).resolves.toEqual({ disposition: 'delivered' });
    expect(restarted.order).toEqual(['resume-turn', 'transport']);
  });
});
