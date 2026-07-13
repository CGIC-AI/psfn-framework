import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  IcpConversationCorrelation,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import {
  createIcpTargetChannelInitiator,
  type RecordedIcpInitiationTurn,
} from './icp-target-channel-initiation.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const ROOT = '99999999-9999-4999-8999-999999999999';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const PERMIT_ID = '55555555-5555-4555-8555-555555555555';
const CONTACT_ID = '66666666-6666-4666-8666-666666666666';
const CHANNEL = `companion-dm:${SENDER}:${RECIPIENT}`;

function permit(): IcpInitiationPermit {
  return {
    permitId: PERMIT_ID,
    candidateId: CANDIDATE,
    conversationId: CONVERSATION,
    senderCompanionId: SENDER,
    recipientCompanionId: RECIPIENT,
    channelId: CHANNEL,
    provenanceRef: 'icp-prov:77777777-7777-4777-8777-777777777777',
    issuedAtMs: Date.parse('2026-07-13T12:00:00.000Z'),
    expiresAtMs: Date.parse('2026-07-13T12:10:00.000Z'),
    status: 'issued',
    revision: 1,
  };
}

function correlation(
  turnId = '018f22a2-52b8-7a3a-8c16-25b7b14f7089',
): IcpConversationCorrelation {
  return {
    conversationId: CONVERSATION,
    rootInitiationId: ROOT,
    initiatedByCompanionId: SENDER,
    localCompanionId: SENDER,
    peerCompanionId: RECIPIENT,
    peerContactId: CONTACT_ID,
    channelId: CHANNEL,
    turnId,
    messageId: `icp-initiation:${CANDIDATE}`,
    requestId: `icp-initiation:${CANDIDATE}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'initiation',
    fatigueDecision: 'not_evaluated',
  };
}

function response(message: SubstrateMessage): AgentResponse {
  const correlation = message.routing?.icpCorrelation;
  if (!correlation) throw new Error('test expected ICP correlation');
  return {
    content: 'Hey Nova, I was thinking about our garden plans.',
    channelId: message.channelId,
    metadata: {
      model: 'deterministic-test-model',
      inputTokens: 12,
      outputTokens: 9,
      durationMs: 3,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      icpCorrelation: correlation,
    },
  };
}

function createHarness(recorded: RecordedIcpInitiationTurn | null = null) {
  const handleMessage = vi.fn(async (
    message: SubstrateMessage,
    deliveryLifecycle: {
      recoveredResponse?: AgentResponse;
      finalizeDelivery(response: AgentResponse): Promise<void>;
    },
  ) => {
    const turnResponse = deliveryLifecycle.recoveredResponse ?? response(message);
    await deliveryLifecycle.finalizeDelivery(turnResponse);
    return turnResponse;
  });
  const findRecordedInitiation = vi.fn(async () => recorded);
  const recordDeliveryObservation = vi.fn(async () => {});
  const findIcpDeliveryObservation = vi.fn(async () => null);
  const sendInitiation = vi.fn(async () => ({
    channelId: CHANNEL,
    messageId: `companion-initiation-${CANDIDATE}`,
    deliveredTo: [RECIPIENT],
    skippedOffline: [],
    permitOutcome: 'consumed' as const,
  }));
  const consumeInitiationPermit = vi.fn(async () => ({ outcome: 'consumed' as const }));
  const initiator = createIcpTargetChannelInitiator({
    localCompanionId: SENDER,
    agent: {
      handleMessage,
      findRecordedIcpInitiation: findRecordedInitiation,
      findIcpDeliveryObservation,
      recordIcpDeliveryObservation: recordDeliveryObservation,
    },
    gateway: { sendInitiation, consumeInitiationPermit },
    authorName: 'Selene',
  });
  return {
    initiator,
    handleMessage,
    findRecordedInitiation,
    findIcpDeliveryObservation,
    recordDeliveryObservation,
    sendInitiation,
    consumeInitiationPermit,
  };
}

describe('ICP target-channel initiation', () => {
  it('runs a private trigger through the ordinary target-channel turn before permit-bound delivery', async () => {
    const harness = createHarness();

    const result = await harness.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    });

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    const message = harness.handleMessage.mock.calls[0][0];
    expect(message).toMatchObject({
      id: `icp-initiation:${CANDIDATE}`,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        canonicalContactId: CONTACT_ID,
        privateTurnTrigger: true,
        icpCorrelation: {
          conversationId: CONVERSATION,
          rootInitiationId: ROOT,
          initiatedByCompanionId: SENDER,
          localCompanionId: SENDER,
          peerCompanionId: RECIPIENT,
          peerContactId: CONTACT_ID,
          channelId: CHANNEL,
          messageId: `icp-initiation:${CANDIDATE}`,
          requestId: `icp-initiation:${CANDIDATE}`,
          chargeLane: 'companion_social',
          surface: 'companion_dm',
          costPurpose: 'conversation_turn',
          costOriginStage: 'initiation',
          fatigueDecision: 'not_evaluated',
        },
      },
    });
    expect(message.content).toBe(
      'Initiate one natural message to the peer in this channel, using the ordinary channel context.',
    );
    expect(harness.sendInitiation).toHaveBeenCalledWith({
      channelId: CHANNEL,
      content: 'Hey Nova, I was thinking about our garden plans.',
      authorName: 'Selene',
      permitId: PERMIT_ID,
      conversationId: CONVERSATION,
      recipientCompanionId: RECIPIENT,
      correlation: result.correlation,
    });
    expect(harness.recordDeliveryObservation).toHaveBeenCalledWith(expect.objectContaining({
      channelId: CHANNEL,
      sourceMessageId: `icp-initiation:${CANDIDATE}`,
      status: 'delivered',
      gatewayMessageId: `companion-initiation-${CANDIDATE}`,
    }));
    expect(result.recoveredTurn).toBe(false);
  });

  it('recovers the recorded assistant turn after restart and retries without another model turn', async () => {
    const firstHarness = createHarness();
    firstHarness.sendInitiation.mockRejectedValueOnce(new Error('peer route unavailable'));

    await expect(firstHarness.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow('peer route unavailable');
    expect(firstHarness.recordDeliveryObservation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'peer route unavailable',
    }));

    const firstMessage = firstHarness.handleMessage.mock.calls[0][0];
    if (!firstMessage.routing?.icpCorrelation) throw new Error('missing test correlation');
    const restartedHarness = createHarness({
      content: 'Hey Nova, I was thinking about our garden plans.',
      correlation: firstMessage.routing.icpCorrelation,
      recoveryResponse: response(firstMessage),
    });
    const failedObservation = firstHarness.recordDeliveryObservation.mock.calls.at(-1)?.[0];
    restartedHarness.findIcpDeliveryObservation.mockResolvedValueOnce(failedObservation);
    restartedHarness.sendInitiation.mockResolvedValueOnce({
      channelId: CHANNEL,
      messageId: `companion-initiation-${CANDIDATE}`,
      deliveredTo: [RECIPIENT],
      skippedOffline: [],
      permitOutcome: 'replayed',
    });

    const result = await restartedHarness.initiator.initiate({
      permit: { ...permit(), status: 'consumed', consumedAtMs: Date.parse('2026-07-13T12:01:00.000Z'), revision: 2 },
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    });

    expect(restartedHarness.handleMessage).toHaveBeenCalledTimes(1);
    expect(restartedHarness.handleMessage.mock.calls[0]?.[1]).toMatchObject({
      recoveredResponse: expect.objectContaining({
        content: 'Hey Nova, I was thinking about our garden plans.',
      }),
    });
    expect(restartedHarness.sendInitiation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ disposition: 'delivered', recoveredTurn: true });
  });

  it('recovers from the assistant row when the process died before any delivery observation', async () => {
    const durableCorrelation = correlation();
    const durableResponse = response({
      id: `icp-initiation:${CANDIDATE}`,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      content: 'private trigger',
      timestamp: new Date(),
      routing: { source: 'companion', icpCorrelation: durableCorrelation },
    });
    const restarted = createHarness({
      content: durableResponse.content,
      correlation: durableCorrelation,
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: {
        ...permit(),
        status: 'consumed',
        consumedAtMs: Date.parse('2026-07-13T12:01:00.000Z'),
        revision: 2,
      },
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).resolves.toMatchObject({ disposition: 'delivered', recoveredTurn: true });

    expect(restarted.handleMessage).toHaveBeenCalledTimes(1);
    expect(restarted.handleMessage.mock.calls[0]?.[1]).toMatchObject({
      recoveredResponse: durableResponse,
    });
    expect(restarted.sendInitiation).toHaveBeenCalledTimes(1);
  });

  it('finishes post-turn recovery without resending after durable delivery', async () => {
    const durableCorrelation = correlation('018f22a2-52b8-7a3a-8c16-25b7b14f7090');
    const recoveryResponse = response({
      id: durableCorrelation.requestId,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      content: 'private trigger',
      timestamp: new Date(),
      routing: { source: 'companion', icpCorrelation: durableCorrelation },
    });
    const restarted = createHarness({
      content: recoveryResponse.content,
      correlation: durableCorrelation,
      recoveryResponse,
    });
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: durableCorrelation.messageId,
      status: 'delivered',
      gatewayMessageId: `companion-initiation-${CANDIDATE}`,
      deliveredTo: [RECIPIENT],
      recoveryResponse,
    });

    await restarted.initiator.initiate({
      permit: {
        ...permit(),
        status: 'consumed',
        consumedAtMs: Date.parse('2026-07-13T12:01:00.000Z'),
        revision: 2,
      },
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    });

    expect(restarted.handleMessage).toHaveBeenCalledTimes(1);
    expect(restarted.sendInitiation).not.toHaveBeenCalled();
    expect(restarted.recordDeliveryObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'delivered', turnCompleted: true }),
    );
  });

  it('coalesces concurrent delivery attempts into one sender turn and one send', async () => {
    const harness = createHarness();
    const request = {
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    };

    const [first, second] = await Promise.all([
      harness.initiator.initiate(request),
      harness.initiator.initiate(request),
    ]);

    expect(first).toEqual(second);
    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendInitiation).toHaveBeenCalledTimes(1);
    expect(harness.recordDeliveryObservation).toHaveBeenCalledTimes(3);
  });

  it('atomically consumes and durably terminates a suppressed one-use permit', async () => {
    const harness = createHarness();
    harness.handleMessage.mockImplementationOnce(async (message, deliveryLifecycle) => {
      const turnResponse = { ...response(message), content: '' };
      await deliveryLifecycle.finalizeDelivery(turnResponse);
      return turnResponse;
    });

    await expect(harness.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).resolves.toMatchObject({ disposition: 'suppressed' });

    expect(harness.consumeInitiationPermit).toHaveBeenCalledWith({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION,
      recipientCompanionId: RECIPIENT,
      channelId: CHANNEL,
      rootInitiationId: ROOT,
    });
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.recordDeliveryObservation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'suppressed',
    }));

    harness.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: `icp-initiation:${CANDIDATE}`,
      status: 'suppressed',
      recoveryResponse: {
        ...response(harness.handleMessage.mock.calls[0][0]),
        content: '',
      },
      turnCompleted: true,
    });
    await expect(harness.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow('already durably suppressed');
    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.consumeInitiationPermit).toHaveBeenCalledTimes(1);
  });

  it('reconciles a consumed suppression after the local observation write was interrupted', async () => {
    const harness = createHarness();

    await expect(harness.initiator.initiate({
      permit: {
        ...permit(),
        status: 'consumed',
        consumedAtMs: Date.parse('2026-07-13T12:01:00.000Z'),
        revision: 2,
      },
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).resolves.toMatchObject({ disposition: 'suppressed', recoveredTurn: true });

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.handleMessage.mock.calls[0]?.[1]).toMatchObject({
      recoveredResponse: expect.objectContaining({ content: '' }),
    });
    expect(harness.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.recordDeliveryObservation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'suppressed',
    }));
  });

  it('fails closed when a permit is not bound to the local companion', async () => {
    const harness = createHarness();
    const anotherSender = '88888888-8888-4888-8888-888888888888';

    await expect(harness.initiator.initiate({
      permit: {
        ...permit(),
        senderCompanionId: anotherSender,
        channelId: `companion-dm:${RECIPIENT}:${anotherSender}`,
      },
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow('authenticated local companion');

    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
  });
});
