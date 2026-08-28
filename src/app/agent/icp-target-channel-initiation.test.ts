import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { deriveStableIcpTargetTurnId } from './icp-target-channel-recovery.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import {
  chargeSurfaceDurably,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const ROOT = '99999999-9999-4999-8999-999999999999';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const PERMIT_ID = '55555555-5555-4555-8555-555555555555';
const CONTACT_ID = '66666666-6666-4666-8666-666666666666';
const CHANNEL = `companion-dm:${SENDER}:${RECIPIENT}`;

function permit(): IcpInitiationPermit {
  const nowMs = Date.now();
  return {
    permitId: PERMIT_ID,
    candidateId: CANDIDATE,
    conversationId: CONVERSATION,
    senderCompanionId: SENDER,
    recipientCompanionId: RECIPIENT,
    channelId: CHANNEL,
    provenanceRef: 'icp-prov:77777777-7777-4777-8777-777777777777',
    issuedAtMs: nowMs - 60_000,
    expiresAtMs: nowMs + 10 * 60_000,
    status: 'issued',
    revision: 1,
  };
}

function consumedPermit(): IcpInitiationPermit {
  const issued = permit();
  return {
    ...issued,
    status: 'consumed',
    consumedAtMs: issued.issuedAtMs + 60_000,
    revision: 2,
  };
}

function expiredConsumedPermit(): IcpInitiationPermit {
  const nowMs = Date.now();
  return {
    ...permit(),
    issuedAtMs: nowMs - 120_000,
    expiresAtMs: nowMs - 30_000,
    status: 'consumed',
    consumedAtMs: nowMs - 60_000,
    revision: 2,
  };
}

function correlation(
  turnId?: string,
): IcpConversationCorrelation {
  const sourceMessageId = `icp-initiation:${CANDIDATE}`;
  return {
    conversationId: CONVERSATION,
    rootInitiationId: ROOT,
    initiatedByCompanionId: SENDER,
    localCompanionId: SENDER,
    peerCompanionId: RECIPIENT,
    peerContactId: CONTACT_ID,
    channelId: CHANNEL,
    turnId: turnId ?? deriveStableIcpTargetTurnId({
      permit: permit(),
      localCompanionId: SENDER,
      peerContactId: CONTACT_ID,
      rootInitiationId: ROOT,
      sourceMessageId,
    }),
    messageId: sourceMessageId,
    requestId: sourceMessageId,
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
      continuationTaskKind: 'research',
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
        icpContinuationTaskKind: 'research',
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

  it('rejects an untyped scheduler continuation kind before starting a turn', async () => {
    const harness = createHarness();

    await expect(harness.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
      continuationTaskKind: 'chat' as 'work',
    })).rejects.toThrow('continuationTaskKind is invalid');

    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
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
      permit: consumedPermit(),
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

  it.each([
    {
      name: 'peer-initiated correlation',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        initiatedByCompanionId: RECIPIENT,
      }),
    },
    {
      name: 'reply-stage correlation',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        costOriginStage: 'reply' as const,
      }),
    },
    {
      name: 'interactive charge lane',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        chargeLane: 'interactive' as const,
      }),
    },
    {
      name: 'unrelated durable turn id',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7099',
      }),
    },
    {
      name: 'wrong channel surface',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        surface: 'companion_room' as const,
      }),
    },
    {
      name: 'wrong cost purpose',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        costPurpose: 'tool' as const,
      }),
    },
    {
      name: 'wrong candidate message lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        messageId: 'icp-initiation:88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong candidate request lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        requestId: 'icp-initiation:88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong root lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        rootInitiationId: '88888888-8888-4888-8888-888888888888',
      }),
    },
  ])('rejects $name before replaying any side effect', async ({ mutate }) => {
    const invalidCorrelation = mutate(correlation());
    const durableResponse = response({
      id: invalidCorrelation.requestId,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      content: 'private trigger',
      timestamp: new Date(),
      routing: { source: 'companion', icpCorrelation: invalidCorrelation },
    });
    const restarted = createHarness({
      content: durableResponse.content,
      correlation: invalidCorrelation,
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: consumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow();

    expect(restarted.handleMessage).not.toHaveBeenCalled();
    expect(restarted.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(restarted.sendInitiation).not.toHaveBeenCalled();
    expect(restarted.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'peer initiator',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        initiatedByCompanionId: RECIPIENT,
      }),
    },
    {
      name: 'wrong local companion',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        localCompanionId: '88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong peer companion',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        peerCompanionId: '88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong peer contact',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        peerContactId: '88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong channel',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        channelId: 'companion-room:study',
        surface: 'companion_room' as const,
      }),
    },
    {
      name: 'wrong conversation',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        conversationId: '88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong root lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        rootInitiationId: '88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong candidate message lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        messageId: 'icp-initiation:88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'wrong candidate request lineage',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        requestId: 'icp-initiation:88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'unrelated durable turn',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7099',
      }),
    },
    {
      name: 'interactive charge lane',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        chargeLane: 'interactive' as const,
      }),
    },
    {
      name: 'wrong channel surface',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        surface: 'companion_room' as const,
      }),
    },
    {
      name: 'wrong cost purpose',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        costPurpose: 'tool' as const,
      }),
    },
    {
      name: 'reply-stage correlation',
      mutate: (value: IcpConversationCorrelation) => ({
        ...value,
        costOriginStage: 'reply' as const,
      }),
    },
  ])('rejects observation-only recovery with $name before every side effect', async ({ mutate }) => {
    const invalidCorrelation = mutate(correlation());
    const durableResponse: AgentResponse = {
      content: 'Durable response that must never be replayed for an invalid binding.',
      channelId: invalidCorrelation.channelId,
      metadata: {
        model: 'deterministic-test-model',
        inputTokens: 12,
        outputTokens: 9,
        durationMs: 3,
        turnId: invalidCorrelation.turnId,
        requestId: invalidCorrelation.requestId,
        icpCorrelation: invalidCorrelation,
      },
    };
    const restarted = createHarness(null);
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: `icp-initiation:${CANDIDATE}`,
      status: 'failed',
      error: 'transport failed before restart',
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow();

    expect(restarted.handleMessage).not.toHaveBeenCalled();
    expect(restarted.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(restarted.sendInitiation).not.toHaveBeenCalled();
    expect(restarted.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'wrong observation channel source',
      observation: () => ({
        channelId: 'companion-room:study',
        sourceMessageId: `icp-initiation:${CANDIDATE}`,
      }),
    },
    {
      name: 'wrong observation candidate source id',
      observation: () => ({
        channelId: CHANNEL,
        sourceMessageId: 'icp-initiation:88888888-8888-4888-8888-888888888888',
      }),
    },
  ])('rejects observation-only recovery with $name before every side effect', async ({ observation }) => {
    const durableCorrelation = correlation();
    const durableResponse: AgentResponse = {
      content: 'Durable response with a mismatched observation envelope.',
      channelId: CHANNEL,
      metadata: {
        model: 'deterministic-test-model',
        inputTokens: 12,
        outputTokens: 9,
        durationMs: 3,
        turnId: durableCorrelation.turnId,
        requestId: durableCorrelation.requestId,
        icpCorrelation: durableCorrelation,
      },
    };
    const restarted = createHarness(null);
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      ...observation(),
      status: 'failed',
      error: 'transport failed before restart',
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/source binding/i);

    expect(restarted.handleMessage).not.toHaveBeenCalled();
    expect(restarted.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(restarted.sendInitiation).not.toHaveBeenCalled();
    expect(restarted.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it('replays an exact observation-only failed response without another model turn', async () => {
    const durableCorrelation = correlation();
    const durableResponse: AgentResponse = {
      content: 'Durable response recovered without an assistant row.',
      channelId: CHANNEL,
      metadata: {
        model: 'deterministic-test-model',
        inputTokens: 12,
        outputTokens: 9,
        durationMs: 3,
        turnId: durableCorrelation.turnId,
        requestId: durableCorrelation.requestId,
        icpCorrelation: durableCorrelation,
      },
    };
    const restarted = createHarness(null);
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: `icp-initiation:${CANDIDATE}`,
      status: 'failed',
      error: 'transport failed before restart',
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: permit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).resolves.toMatchObject({ disposition: 'delivered', recoveredTurn: true });

    expect(restarted.handleMessage).toHaveBeenCalledTimes(1);
    expect(restarted.handleMessage.mock.calls[0]?.[1]).toMatchObject({
      recoveredResponse: durableResponse,
    });
    expect(restarted.sendInitiation).toHaveBeenCalledTimes(1);
  });

  it('reconstructs one stable social-charge identity after a pre-response process crash', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-icp-pre-response-charge-'));
    const ledgerPath = join(tempDir, 'charge-ledger.jsonl');
    const observedTurnIds: string[] = [];
    try {
      const firstLedger = new RunChargeLedger(ledgerPath);
      const first = createHarness();
      first.handleMessage.mockImplementationOnce(async (message) => {
        const turnId = message.routing?.icpCorrelation?.turnId;
        if (!turnId) throw new Error('test requires target-turn correlation');
        observedTurnIds.push(turnId);
        await runWithChargeContext({
          chargePolicy: makeTestChargePolicyConfig(),
          lane: 'companion_social',
          runId: `${turnId}:companion-social`,
        }, async () => {
          await chargeSurfaceDurably('companionSocialContinuation', {
            eventId: `${turnId}:companion-social`,
            probeChargeEvent: event => firstLedger.probeChargeEvent(event),
            recordChargeEvent: event => firstLedger.commitChargeEvent(event).outcome,
          });
        });
        throw new Error('process crashed before assistant persistence');
      });

      await expect(first.initiator.initiate({
        permit: permit(),
        rootInitiationId: ROOT,
        peerContactId: CONTACT_ID,
      })).rejects.toThrow('process crashed before assistant persistence');
      firstLedger.close();
      expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);

      resetRunChargeRollingWindowForTests();
      const restartedLedger = new RunChargeLedger(ledgerPath);
      const restarted = createHarness();
      restarted.handleMessage.mockImplementationOnce(async (message, deliveryLifecycle) => {
        const turnId = message.routing?.icpCorrelation?.turnId;
        if (!turnId) throw new Error('test requires target-turn correlation');
        observedTurnIds.push(turnId);
        await runWithChargeContext({
          chargePolicy: makeTestChargePolicyConfig(),
          lane: 'companion_social',
          runId: `${turnId}:companion-social`,
        }, async () => {
          await chargeSurfaceDurably('companionSocialContinuation', {
            eventId: `${turnId}:companion-social`,
            probeChargeEvent: event => restartedLedger.probeChargeEvent(event),
            recordChargeEvent: event => restartedLedger.commitChargeEvent(event).outcome,
          });
        });
        const turnResponse = response(message);
        await deliveryLifecycle.finalizeDelivery(turnResponse);
        return turnResponse;
      });

      await expect(restarted.initiator.initiate({
        permit: permit(),
        rootInitiationId: ROOT,
        peerContactId: CONTACT_ID,
      })).resolves.toMatchObject({ disposition: 'delivered' });
      restartedLedger.close();

      expect(observedTurnIds).toHaveLength(2);
      expect(observedTurnIds[1]).toBe(observedTurnIds[0]);
      expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      resetRunChargeRollingWindowForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('recovers an expired consumed permit only from exact durable delivery evidence', async () => {
    const durableCorrelation = correlation();
    const durableResponse = response({
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
      content: durableResponse.content,
      correlation: durableCorrelation,
      recoveryResponse: durableResponse,
    });
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: durableCorrelation.messageId,
      status: 'failed',
      error: 'gateway restarted after consumption',
      recoveryResponse: durableResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: expiredConsumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).resolves.toMatchObject({ disposition: 'delivered', recoveredTurn: true });
    expect(restarted.handleMessage).toHaveBeenCalledTimes(1);
    expect(restarted.sendInitiation).toHaveBeenCalledTimes(1);

    const missingEvidence = createHarness();
    await expect(missingEvidence.initiator.initiate({
      permit: expiredConsumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/missing durable/i);
    expect(missingEvidence.handleMessage).not.toHaveBeenCalled();
    expect(missingEvidence.sendInitiation).not.toHaveBeenCalled();
  });

  it('rejects a failed restart with whitespace-only transport content before execution', async () => {
    const durableCorrelation = correlation();
    const whitespaceResponse = {
      ...response({
        id: durableCorrelation.requestId,
        channelId: CHANNEL,
        channelType: 'companion',
        authorId: 'system:icp-initiation',
        authorName: 'ICP Initiation',
        content: 'private trigger',
        timestamp: new Date(),
        routing: { source: 'companion', icpCorrelation: durableCorrelation },
      }),
      content: ' \n\t ',
    };
    const restarted = createHarness({
      content: whitespaceResponse.content,
      correlation: durableCorrelation,
      recoveryResponse: whitespaceResponse,
    });
    restarted.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: durableCorrelation.messageId,
      status: 'failed',
      error: 'transport failed',
      recoveryResponse: whitespaceResponse,
    });

    await expect(restarted.initiator.initiate({
      permit: consumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/failed.*transport content/i);

    expect(restarted.handleMessage).not.toHaveBeenCalled();
    expect(restarted.sendInitiation).not.toHaveBeenCalled();
    expect(restarted.recordDeliveryObservation).not.toHaveBeenCalled();
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
      permit: consumedPermit(),
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
    const durableCorrelation = correlation();
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
      permit: consumedPermit(),
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
      peerContactId: CONTACT_ID,
      terminalReasonCode: 'conversation_ended',
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
    })).resolves.toMatchObject({
      disposition: 'suppressed',
      recoveredTurn: true,
      correlation: expect.objectContaining({
        conversationId: CONVERSATION,
        rootInitiationId: ROOT,
      }),
    });
    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.consumeInitiationPermit).toHaveBeenCalledTimes(1);
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.recordDeliveryObservation).toHaveBeenCalledTimes(3);
  });

  it('reconciles a consumed suppression after the local observation write was interrupted', async () => {
    const harness = createHarness();
    const suppressionCorrelation = correlation();
    const suppressionResponse = {
      ...response({
        id: suppressionCorrelation.requestId,
        channelId: CHANNEL,
        channelType: 'companion',
        authorId: 'system:icp-initiation',
        authorName: 'ICP Initiation',
        content: 'private trigger',
        timestamp: new Date(),
        routing: { source: 'companion', icpCorrelation: suppressionCorrelation },
      }),
      content: '',
    };
    harness.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: `icp-initiation:${CANDIDATE}`,
      status: 'prepared',
      recoveryResponse: suppressionResponse,
    });

    await expect(harness.initiator.initiate({
      permit: consumedPermit(),
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

  it('rejects contradictory terminal suppression evidence before replaying any side effect', async () => {
    const harness = createHarness();
    const durableCorrelation = correlation();
    const deliverableResponse = response({
      id: durableCorrelation.requestId,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      content: 'private trigger',
      timestamp: new Date(),
      routing: { source: 'companion', icpCorrelation: durableCorrelation },
    });
    harness.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: durableCorrelation.messageId,
      status: 'suppressed',
      recoveryResponse: deliverableResponse,
      turnCompleted: true,
    });

    await expect(harness.initiator.initiate({
      permit: consumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/suppressed recovery contains a deliverable response/i);

    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it('rejects contradictory assistant and terminal suppression records before any side effect', async () => {
    const durableCorrelation = correlation();
    const deliverableResponse = response({
      id: durableCorrelation.requestId,
      channelId: CHANNEL,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      content: 'private trigger',
      timestamp: new Date(),
      routing: { source: 'companion', icpCorrelation: durableCorrelation },
    });
    const harness = createHarness({
      content: deliverableResponse.content,
      correlation: durableCorrelation,
      recoveryResponse: deliverableResponse,
    });
    harness.findIcpDeliveryObservation.mockResolvedValueOnce({
      channelId: CHANNEL,
      sourceMessageId: durableCorrelation.messageId,
      status: 'suppressed',
      recoveryResponse: { ...deliverableResponse, content: '' },
      turnCompleted: true,
    });

    await expect(harness.initiator.initiate({
      permit: consumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/durable assistant and delivery observation do not match/i);

    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.consumeInitiationPermit).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it('fails closed when a consumed permit has no durable assistant or prepared observation', async () => {
    const harness = createHarness();

    await expect(harness.initiator.initiate({
      permit: consumedPermit(),
      rootInitiationId: ROOT,
      peerContactId: CONTACT_ID,
    })).rejects.toThrow(/missing durable prepared suppression recovery evidence/i);

    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.sendInitiation).not.toHaveBeenCalled();
    expect(harness.consumeInitiationPermit).not.toHaveBeenCalled();
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
