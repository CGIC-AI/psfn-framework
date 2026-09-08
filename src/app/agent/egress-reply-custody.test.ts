// Chain of custody on the autonomous-reply egress surface
// (psfn-framework-ccgdz.6): the delivered reply is joinable to its custody
// snapshot AND to the room event that triggered it, and an outward reply whose
// chain is incomplete is held with a typed reason rather than sent.

import { describe, expect, it, vi } from 'vitest';

import { createAgentLoopEgressReplySender } from './egress-reply-sender.js';
import type {
  EgressReplyDeliveryRequest,
  InboundRoomMessageEgressReplyTrigger,
} from '../../core/agent/arbiter/egress-lease-phase.js';
import { EgressDeliveryRecorder } from '../../core/cogsec/disclosure/index.js';
import {
  custodyIdentity,
  custodySha256,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import {
  egressContentSha256,
  type CompletedTurnEgressCustodyCapture,
  type EgressDeliveryRecord,
  type TurnEgressCustodyProof,
} from '../../core/cogsec/disclosure/egress-delivery-record.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type { CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import type { ChannelDisclosureContext } from '../../system/trust/policy.js';
import type {
  AgentResponse,
  SubstrateMessage,
  TurnID,
} from '../../shared/contracts/runtime.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const COMPANION_A = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const COMPANION_B = '9a8b7c66-1d2e-4f3a-8b9c-0d1e2f3a4b5c';
const ROOM_CHANNEL = 'discord:guild-1:general';
const SOURCE_EVENT_ID = 'evt-1';
const PUBLIC_DISCLOSURE: ChannelDisclosureContext = { channelPrivacy: 'public', broadcast: false };

const PROVEN: TurnEgressCustodyProof = {
  custodySnapshotRef: `turn:${TURN_ID}`,
  sourceCount: 3,
  hasUnclassifiedSource: false,
  classification: 'auto_shareable',
  effectiveSensitivity: 'public',
};

function response(content: string): AgentResponse {
  return {
    content,
    channelId: `internal:egress-reply:${ROOM_CHANNEL}`,
    metadata: {
      model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1,
      turnId: TURN_ID as TurnID,
      requestId: `egress-reply:${SOURCE_EVENT_ID}`,
    },
  } as AgentResponse;
}

function makeRequest(
  overrides: Partial<InboundRoomMessageEgressReplyTrigger> = {},
): EgressReplyDeliveryRequest {
  return {
    reservation: {} as EgressReplyDeliveryRequest['reservation'],
    lease: {} as EgressReplyDeliveryRequest['lease'],
    appraisal: { action: 'reply', reasonCode: 'addressed', confidence: 0.9 },
    trigger: {
      kind: 'inbound_room_message',
      channelId: ROOM_CHANNEL,
      channelType: 'discord',
      sourceEventId: SOURCE_EVENT_ID,
      authorId: 'human-1',
      authorName: 'Sam',
      content: 'hey companion',
      occurredAtMs: 1_000,
      ...overrides,
    },
    nowMs: 2_000,
  };
}

function fakeStore() {
  const rows: EgressDeliveryRecord[] = [];
  return {
    rows,
    port: {
      record: vi.fn(async (record: EgressDeliveryRecord) => {
        rows.push(record);
        return 'recorded' as const;
      }),
      getByDeliveryRef: async () => null,
      listByGenerationContextRef: async () => [],
      close: async () => {},
    },
  };
}

function makeSender(input: {
  reply: string;
  custody?: TurnEgressCustodyProof;
  mode: CogSecMode;
  store: ReturnType<typeof fakeStore>;
  companionId?: string;
  guard?: OutboundReplyDeduper;
  send?: ReturnType<typeof vi.fn>;
}) {
  // The generator hands its custody proof over through the one-shot capture
  // hook, exactly as SubstrateAgent does before it clears the turn's state.
  const generator = {
    handleMessage: vi.fn(async (
      _message: SubstrateMessage,
      _lifecycle?: undefined,
      _control?: undefined,
      _lineage?: undefined,
      capture?: CompletedTurnEgressCustodyCapture,
    ) => {
      capture?.(input.custody ? { turnId: TURN_ID, proof: input.custody } : null);
      return response(input.reply);
    }),
  };
  const delivery = { send: input.send ?? vi.fn(async () => undefined) };
  const sender = createAgentLoopEgressReplySender({
    generator,
    delivery,
    companionName: 'Companion',
    outboundReplyGuard: input.guard ?? new OutboundReplyDeduper(),
    resolveDestinationDisclosure: () => PUBLIC_DISCLOSURE,
    egressDeliveryRecorder: new EgressDeliveryRecorder({
      store: input.store.port,
      ...(input.companionId !== undefined ? { companionId: input.companionId } : {}),
      getCogSecMode: () => input.mode,
      now: () => 1_800_000_000_000,
    }),
  });
  return { sender, generator, delivery };
}

describe('autonomous room reply egress custody', () => {
  it('records direct text against its custody snapshot and its trigger event', async () => {
    const store = fakeStore();
    const { sender, generator, delivery } = makeSender({
      reply: 'Hi Sam!', custody: PROVEN, mode: 'boundary', store, companionId: COMPANION_A,
    });

    expect(await sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(delivery.send).toHaveBeenCalledWith('discord', ROOM_CHANNEL, 'Hi Sam!');

    // The synthetic generation turn carries the trigger's correlation forward
    // rather than a fresh identifier, so the delivered reply joins back to the
    // room event that caused it.
    const generated = generator.handleMessage.mock.calls[0]?.[0];
    expect(generated?.id).toBe(`egress-reply:${SOURCE_EVENT_ID}`);
    expect(generated?.routing?.egressReplyTrigger).toEqual({
      schemaVersion: 1,
      sourceEventId: SOURCE_EVENT_ID,
      channelId: ROOM_CHANNEL,
      channelType: 'discord',
    });

    const [row] = store.rows;
    expect(row?.surface).toBe('social_reply');
    expect(row?.disposition).toBe('released');
    // Delivered bytes -> turn -> custody snapshot -> destination -> outcome.
    expect(row?.contentSha256).toBe(egressContentSha256('Hi Sam!'));
    expect(row?.generationContextRef).toBe(`turn:${TURN_ID}`);
    expect(row?.custodySnapshotRef).toBe(`turn:${TURN_ID}`);
    expect(row?.destination).toEqual({
      kind: 'public_room',
      ref: custodyIdentity(ROOM_CHANNEL),
    });
    expect(row?.triggerEventRef?.digest).toBe(custodySha256(SOURCE_EVENT_ID));
    expect(row?.decisionAllowed).toBe(true);
    expect(row?.holdReason).toBeUndefined();
    expect(row?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
  });

  it('holds an outward reply with no admitted source, and sends nothing', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!',
      custody: { ...PROVEN, sourceCount: 0, classification: 'non_shareable' },
      mode: 'boundary',
      store,
    });

    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'no_admitted_source' });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.holdReason).toBe('no_admitted_source');
    expect(store.rows[0]?.decisionAllowed).toBe(false);
  });

  it('holds when an admitted source carried no usable lineage', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!',
      custody: { ...PROVEN, hasUnclassifiedSource: true, classification: 'non_shareable' },
      mode: 'strict',
      store,
    });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'unclassified_source' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('holds when the turn folded a lineage but no snapshot survives it', async () => {
    const store = fakeStore();
    const custody: TurnEgressCustodyProof = {
      sourceCount: 3,
      hasUnclassifiedSource: false,
      classification: 'auto_shareable',
      effectiveSensitivity: 'public',
    };
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!', custody, mode: 'boundary', store,
    });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'custody_snapshot_missing' });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(store.rows[0]?.custodySnapshotRef).toBeUndefined();
  });

  it('holds when the turn published no custody proof at all', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!', mode: 'boundary', store,
    });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'lineage_missing' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('observes without withholding under a shadow posture', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!',
      custody: { ...PROVEN, sourceCount: 0, classification: 'non_shareable' },
      mode: 'shadow',
      store,
    });
    expect(await sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    // Released, but the condition is on the record: shadow observes, it does
    // not pretend the chain was intact.
    expect(store.rows[0]?.disposition).toBe('released');
    expect(store.rows[0]?.holdReason).toBe('no_admitted_source');
    expect(store.rows[0]?.enforcementPosture).toBe('shadow');
  });

  it('holds when the delivery record itself cannot be written', async () => {
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!', custody: PROVEN, mode: 'boundary', store,
    });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'custody_store_unavailable' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('leaves the trigger free to speak again once its chain is repaired', async () => {
    // A hold must not burn the trigger's single-delivery fence: the reply never
    // left, so a later run with a complete chain is not a double-send risk.
    const held = fakeStore();
    const { sender: holdingSender } = makeSender({
      reply: 'Hi Sam!', mode: 'boundary', store: held,
    });
    await holdingSender.deliver(makeRequest());

    const repaired = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!', custody: PROVEN, mode: 'boundary', store: repaired,
    });
    expect(await sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a declined reply: no bytes, no delivery', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: '__no_reply__', custody: PROVEN, mode: 'boundary', store,
    });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'failed', detail: 'model_declined' });
    expect(delivery.send).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('does not re-record a re-driven trigger the fence already delivered', async () => {
    const store = fakeStore();
    const { sender, delivery } = makeSender({
      reply: 'Hi Sam!', custody: PROVEN, mode: 'boundary', store,
    });
    expect(await sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(await sender.deliver(makeRequest()))
      .toEqual({ outcome: 'delivered', detail: 'duplicate_event_suppressed' });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
  });

  it('keeps two companions replying to one room event in separate rows', async () => {
    const storeA = fakeStore();
    const storeB = fakeStore();
    const a = makeSender({
      reply: 'Hi Sam!', custody: PROVEN, mode: 'boundary', store: storeA, companionId: COMPANION_A,
    });
    const b = makeSender({
      reply: 'Hello!', custody: PROVEN, mode: 'boundary', store: storeB, companionId: COMPANION_B,
    });
    expect(await a.sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(await b.sender.deliver(makeRequest())).toEqual({ outcome: 'delivered' });
    expect(storeA.rows[0]?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
    expect(storeB.rows[0]?.owner).toEqual({ kind: 'companion', companionId: COMPANION_B });
    // Different bytes, same trigger event: each row proves its own delivery.
    expect(storeA.rows[0]?.contentSha256).not.toBe(storeB.rows[0]?.contentSha256);
    expect(storeA.rows[0]?.triggerEventRef).toEqual(storeB.rows[0]?.triggerEventRef);
  });
});
