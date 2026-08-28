import { once } from 'node:events';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { BuzzAdapter, type BuzzAdapterConfig } from './adapter.js';
import { InMemoryBuzzRecoveryStore } from './recovery-store.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CHANNEL_ID = '33333333-3333-4333-8333-333333333333';

interface TestRelay {
  server: WebSocketServer;
  url: string;
  relaySecretKey: Uint8Array;
  relayPubkey: string;
  companionSecretKey: Uint8Array;
  companionPubkey: string;
  authorSecretKey: Uint8Array;
  authorPubkey: string;
}

const openRelays: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(openRelays.splice(0).map(async server => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});

async function createTestRelay(): Promise<TestRelay> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  openRelays.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test relay did not bind TCP');
  const companionSecretKey = generateSecretKey();
  const authorSecretKey = generateSecretKey();
  const relaySecretKey = generateSecretKey();
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
    relaySecretKey,
    relayPubkey: getPublicKey(relaySecretKey),
    companionSecretKey,
    companionPubkey: getPublicKey(companionSecretKey),
    authorSecretKey,
    authorPubkey: getPublicKey(authorSecretKey),
  };
}

function makeConfig(relay: TestRelay): BuzzAdapterConfig {
  return {
    enabled: true,
    relayUrl: relay.url,
    relayPubkey: relay.relayPubkey,
    companionId: COMPANION_ID,
    privateKey: Buffer.from(relay.companionSecretKey).toString('hex'),
    channelIds: [CHANNEL_ID],
    allowedAuthorPubkeys: [relay.authorPubkey],
    machineAuthorPubkeys: [],
    maxAutonomousReplyHops: 4,
    noInformationAcknowledgements: ['acknowledged'],
    replayWindowSeconds: 30,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 10,
    maxReconnectAttempts: 1,
    maxFutureEventSkewSeconds: 30,
  };
}

function makeOptions(
  shutdownTimeoutMs: number,
  log?: RuntimeChannelLifecycleLogger,
): ConstructorParameters<typeof BuzzAdapter>[1] {
  return {
    shutdownTimeoutMs,
    recoveryStore: new InMemoryBuzzRecoveryStore(),
    ...(log ? { log } : {}),
  };
}

function responseFor(message: SubstrateMessage): AgentResponse {
  return {
    content: 'I will coordinate that.',
    channelId: message.channelId,
    metadata: {
      model: 'test-model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
    },
  };
}

function signStreamEvent(input: {
  secretKey: Uint8Array;
  channelId?: string;
  companionPubkey?: string;
  content?: string;
  kind?: number;
  createdAt?: number;
  extraTags?: string[][];
}): Event {
  return finalizeEvent({
    kind: input.kind ?? 9,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1_000),
    content: input.content ?? 'Please take this work.',
    tags: [
      ['h', input.channelId ?? CHANNEL_ID],
      ...(input.companionPubkey ? [['p', input.companionPubkey]] : []),
      ...(input.extraTags ?? []),
    ],
  }, input.secretKey);
}

function signMachineStreamEvent(input: {
  relay: TestRelay;
  hop: number;
  content?: string;
  rootEventId?: string;
  parentEventId?: string;
}): Event {
  const rootEventId = input.rootEventId ?? 'd'.repeat(64);
  return signStreamEvent({
    secretKey: input.relay.authorSecretKey,
    companionPubkey: input.relay.companionPubkey,
    content: input.content,
    extraTags: [
      ['e', input.parentEventId ?? 'e'.repeat(64), '', 'reply'],
      ['agent-root', rootEventId],
      ['agent-chain', rootEventId],
      ['agent-hop', String(input.hop)],
      ['agent-recipient', input.relay.companionPubkey],
    ],
  });
}

function startAuthenticatedRelay(
  relay: TestRelay,
  onSubscribed: (socket: WebSocket, subscriptionId: string) => void,
  onPublished: (event: Event) => void,
  publishAcknowledgement: { accepted: boolean; message: string }
    | ((event: Event) => { accepted: boolean; message: string } | null)
    | null = {
    accepted: true,
    message: 'stored',
  },
  options: {
    initialChannelIds?: readonly string[];
    onMembershipSubscription?: (socket: WebSocket, subscriptionId: string) => void;
    acknowledgeClose?: boolean;
  } = {},
): void {
  relay.server.on('connection', socket => {
    socket.send(JSON.stringify(['AUTH', 'test-challenge']));
    socket.on('message', (raw: RawData) => {
      const frame = JSON.parse(raw.toString()) as unknown[];
      if (frame[0] === 'AUTH') {
        const event = frame[1] as Event;
        expect(verifyEvent(event)).toBe(true);
        expect(event.kind).toBe(22_242);
        expect(event.pubkey).toBe(relay.companionPubkey);
        expect(event.tags).toContainEqual(['relay', relay.url]);
        expect(event.tags).toContainEqual(['challenge', 'test-challenge']);
        socket.send(JSON.stringify(['OK', event.id, true, 'authenticated']));
        return;
      }
      if (frame[0] === 'REQ') {
        const subscriptionId = frame[1] as string;
        const filter = frame[2] as { kinds?: number[] };
        if (filter.kinds?.[0] === 39_002) {
          for (const channelId of options.initialChannelIds ?? [CHANNEL_ID]) {
            const membership = finalizeEvent({
              kind: 39_002,
              created_at: Math.floor(Date.now() / 1_000),
              content: '',
              tags: [['d', channelId], ['p', relay.companionPubkey]],
            }, relay.relaySecretKey);
            socket.send(JSON.stringify(['EVENT', subscriptionId, membership]));
          }
          socket.send(JSON.stringify(['EOSE', subscriptionId]));
          return;
        }
        if (filter.kinds?.[0] === 44_100) {
          options.onMembershipSubscription?.(socket, subscriptionId);
          return;
        }
        expect(frame[2]).toMatchObject({
          kinds: [9],
          '#h': [CHANNEL_ID],
          '#p': [relay.companionPubkey],
          since: expect.any(Number),
        });
        onSubscribed(socket, subscriptionId);
        return;
      }
      if (frame[0] === 'EVENT') {
        const event = frame[1] as Event;
        onPublished(event);
        const acknowledgement = typeof publishAcknowledgement === 'function'
          ? publishAcknowledgement(event)
          : publishAcknowledgement;
        if (acknowledgement) {
          socket.send(JSON.stringify([
            'OK',
            event.id,
            acknowledgement.accepted,
            acknowledgement.message,
          ]));
        }
        return;
      }
      if (
        frame[0] === 'CLOSE'
        && typeof frame[1] === 'string'
        && options.acknowledgeClose !== false
      ) {
        socket.send(JSON.stringify(['CLOSED', frame[1], '']));
      }
    });
  });
}

describe('BuzzAdapter', () => {
  it('authenticates, routes one allowed top-level mention, and publishes an anchored reply', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    const published: Event[] = [];
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event));

    const handled: SubstrateMessage[] = [];
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => {
      handled.push(message);
      return responseFor(message);
    });

    await adapter.start();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await adapter.stop();

    expect(handled).toEqual([expect.objectContaining({
      id: inbound.id,
      channelId: `buzz:${encodeURIComponent(relay.url)}:${CHANNEL_ID}`,
      channelType: 'buzz',
      authorId: `buzz:${encodeURIComponent(relay.url)}:${relay.authorPubkey}`,
      content: 'Please take this work.',
      isDirectMessage: false,
      routing: expect.objectContaining({
        source: 'buzz',
        responseMode: 'respond',
        channelPrivacy: 'invite_only',
        addressing: expect.objectContaining({
          source: 'buzz',
          channel: {
            scope: 'group',
            channelId: `buzz:${encodeURIComponent(relay.url)}:${CHANNEL_ID}`,
          },
          resolvedAddressee: {
            kind: 'participants',
            participants: [expect.objectContaining({
              authorId: `buzz:${encodeURIComponent(relay.url)}:${relay.companionPubkey}`,
              evidence: ['mention'],
            })],
          },
        }),
      }),
    })]);

    const reply = published[0]!;
    expect(verifyEvent(reply)).toBe(true);
    expect(reply.pubkey).toBe(relay.companionPubkey);
    expect(reply.kind).toBe(9);
    expect(reply.content).toBe('I will coordinate that.');
    expect(reply.tags).toEqual([
      ['h', CHANNEL_ID],
      ['e', inbound.id, '', 'reply'],
      ['p', relay.authorPubkey],
      ['agent-root', inbound.id],
      ['agent-chain', inbound.id],
      ['agent-hop', '1'],
      ['agent-recipient', relay.authorPubkey],
    ]);
  });

  it('rejects wrong channels, kinds, addressing, authors, signatures, threads, and self events', async () => {
    const relay = await createTestRelay();
    const strangerKey = generateSecretKey();
    const invalidSignature = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
      content: 'signed content',
    });
    invalidSignature.content = 'tampered content';
    const rejected = [
      signStreamEvent({
        secretKey: relay.authorSecretKey,
        channelId: OTHER_CHANNEL_ID,
        companionPubkey: relay.companionPubkey,
      }),
      signStreamEvent({
        secretKey: relay.authorSecretKey,
        companionPubkey: relay.companionPubkey,
        kind: 1,
      }),
      signStreamEvent({ secretKey: relay.authorSecretKey }),
      signStreamEvent({ secretKey: strangerKey, companionPubkey: relay.companionPubkey }),
      invalidSignature,
      signStreamEvent({
        secretKey: relay.authorSecretKey,
        companionPubkey: relay.companionPubkey,
        extraTags: [['e', 'f'.repeat(64), '', 'reply']],
      }),
      signStreamEvent({
        secretKey: relay.companionSecretKey,
        companionPubkey: relay.companionPubkey,
      }),
    ];
    const accepted = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
      content: 'the only accepted event',
    });
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      for (const event of [...rejected, accepted]) {
        socket.send(JSON.stringify(['EVENT', subscriptionId, event]));
      }
    }, () => undefined);

    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await adapter.stop();

    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      id: accepted.id,
      content: 'the only accepted event',
    });
  });

  it('claims concurrent relay replays once and publishes one reply', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    const published: Event[] = [];
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event));

    let release!: (response: AgentResponse) => void;
    const response = new Promise<AgentResponse>(resolve => {
      release = resolve;
    });
    const handler = vi.fn(async () => await response);
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    release(responseFor(handler.mock.calls[0]![0]));
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await adapter.stop();
  });

  it('reuses the exact signed reply after restart without rerunning cognition', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    const published: Event[] = [];
    let acknowledge = false;
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event), () => acknowledge
      ? { accepted: true, message: 'stored' }
      : null);
    const recoveryStore = new InMemoryBuzzRecoveryStore();

    const firstHandler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const first = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 50,
      recoveryStore,
    });
    first.onOperatorAlert(async () => undefined);
    first.onMessage(firstHandler);
    await first.start();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await expect(first.stop()).rejects.toThrow('Buzz cancelled turn cleanup failed');

    acknowledge = true;
    const secondHandler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const second = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 2_000,
      recoveryStore,
    });
    second.onOperatorAlert(async () => undefined);
    second.onMessage(secondHandler);
    await second.start();
    await vi.waitFor(() => expect(published).toHaveLength(2));
    await second.stop();

    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).not.toHaveBeenCalled();
    expect(published[1]).toEqual(published[0]);
  });

  it('terminates machine acknowledgement and hop-limit events without cognition or publication', async () => {
    const relay = await createTestRelay();
    const events = [
      signMachineStreamEvent({ relay, hop: 1, content: 'acknowledged' }),
      signMachineStreamEvent({
        relay,
        hop: 4,
        rootEventId: 'a'.repeat(64),
        parentEventId: 'b'.repeat(64),
      }),
    ];
    const published: Event[] = [];
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      for (const event of events) socket.send(JSON.stringify(['EVENT', subscriptionId, event]));
    }, event => published.push(event));
    const config = makeConfig(relay);
    config.machineAuthorPubkeys = [relay.authorPubkey];
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(config, makeOptions(2_000, log));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2));
    await adapter.stop();

    expect(handler).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'no_information_acknowledgement' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'autonomous_hop_limit' }),
    );
  });

  it('treats fatigue suppression as terminal silence', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    const published: Event[] = [];
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event));
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000, log));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => {
      const response = responseFor(message);
      response.metadata.fatigue = {
        modelDisposition: 'suppressed',
      } as AgentResponse['metadata']['fatigue'];
      return response;
    });

    await adapter.start();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'fatigue_suppressed' }),
    ));
    await adapter.stop();

    expect(published).toEqual([]);
  });

  it('rejects a machine chain whose claimed human root was never observed', async () => {
    const relay = await createTestRelay();
    const inbound = signMachineStreamEvent({
      relay,
      hop: 1,
      content: 'Please continue this chain.',
    });
    const published: Event[] = [];
    const config = makeConfig(relay);
    config.machineAuthorPubkeys = [relay.authorPubkey];
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event));
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(config, makeOptions(2_000, log));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'invalid_causal_parent' }),
    ));
    await adapter.stop();

    expect(handler).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('subscribes after a signed membership add and cancels the turn on removal', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    let membershipSocket: WebSocket | undefined;
    let membershipSubscriptionId: string | undefined;
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, () => undefined, { accepted: true, message: 'stored' }, {
      initialChannelIds: [],
      onMembershipSubscription: (socket, subscriptionId) => {
        membershipSocket = socket;
        membershipSubscriptionId = subscriptionId;
      },
    });
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000, log));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async (_message, options) => {
      const signal = options?.signal;
      if (!signal || !membershipSocket || !membershipSubscriptionId) {
        throw new Error('Buzz membership cancellation test was not initialized');
      }
      const removal = finalizeEvent({
        kind: 44_101,
        created_at: Math.floor(Date.now() / 1_000) + 1,
        content: '',
        tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
      }, relay.relaySecretKey);
      membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, removal]));
      return await new Promise<AgentResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    await adapter.start();
    await vi.waitFor(() => expect(membershipSocket).toBeDefined());
    if (!membershipSocket || !membershipSubscriptionId) throw new Error('Buzz membership subscription was not established');
    const addition = finalizeEvent({
      kind: 44_100,
      created_at: Math.floor(Date.now() / 1_000),
      content: '',
      tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
    }, relay.relaySecretKey);
    membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, addition]));
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'turn_cancelled' }),
    ));
    await adapter.stop();
  });

  it('keeps a newer signed membership removal authoritative over an older replayed add', async () => {
    const relay = await createTestRelay();
    let membershipSocket: WebSocket | undefined;
    let membershipSubscriptionId: string | undefined;
    const onStreamSubscribed = vi.fn();
    startAuthenticatedRelay(relay, (_socket, subscriptionId) => {
      onStreamSubscribed(subscriptionId);
    }, () => undefined, { accepted: true, message: 'stored' }, {
      initialChannelIds: [],
      onMembershipSubscription: (socket, subscriptionId) => {
        membershipSocket = socket;
        membershipSubscriptionId = subscriptionId;
      },
    });
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    if (!membershipSocket || !membershipSubscriptionId) throw new Error('membership stream was not ready');
    const createdAt = Math.floor(Date.now() / 1_000);
    const removal = finalizeEvent({
      kind: 44_101,
      created_at: createdAt + 2,
      content: '',
      tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
    }, relay.relaySecretKey);
    const staleAddition = finalizeEvent({
      kind: 44_100,
      created_at: createdAt + 1,
      content: '',
      tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
    }, relay.relaySecretKey);
    membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, removal]));
    membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, staleAddition]));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(onStreamSubscribed).not.toHaveBeenCalled();

    const currentAddition = finalizeEvent({
      kind: 44_100,
      created_at: createdAt + 3,
      content: '',
      tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
    }, relay.relaySecretKey);
    membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, currentAddition]));
    await vi.waitFor(() => expect(onStreamSubscribed).toHaveBeenCalledOnce());
    await adapter.stop();
  });

  it('fails startup when NIP-42 authentication is rejected', async () => {
    const relay = await createTestRelay();
    relay.server.on('connection', socket => {
      socket.send(JSON.stringify(['AUTH', 'denied-challenge']));
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()) as unknown[];
        if (frame[0] === 'AUTH') {
          const event = frame[1] as Event;
          socket.send(JSON.stringify(['OK', event.id, false, 'membership required']));
        }
      });
    });
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => responseFor(message));

    await expect(adapter.start()).rejects.toThrow(
      'Buzz relay rejected NIP-42 authentication: membership required',
    );
    await adapter.stop();
  });

  it('reports a rejected response publication through the operator-alert path', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, () => undefined, { accepted: false, message: 'room became read-only' });

    const alertHandler = vi.fn(async () => undefined);
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));
    adapter.onOperatorAlert(alertHandler);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    await vi.waitFor(() => expect(alertHandler).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buzz message processing failed',
      message: expect.stringContaining('room became read-only'),
      idempotencyKey: `buzz:message-processing:${COMPANION_ID}`,
    })));
    await adapter.stop();
  });

  it('bounds a missing response acknowledgement and alerts the operator', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, () => undefined, null);

    const alertHandler = vi.fn(async () => undefined);
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(50));
    adapter.onOperatorAlert(alertHandler);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    await vi.waitFor(() => expect(alertHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('timed out acknowledging event'),
    })));
    await expect(adapter.stop()).rejects.toThrow('Buzz cancelled turn cleanup failed');
  });

  it('reports connection loss and preserves an operator-alert delivery failure in logs', async () => {
    const relay = await createTestRelay();
    startAuthenticatedRelay(relay, socket => socket.close(), () => undefined);
    const log: RuntimeChannelLifecycleLogger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const alertHandler = vi.fn(async () => {
      throw new Error('operator sink offline');
    });
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000, log));
    adapter.onOperatorAlert(alertHandler);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    await vi.waitFor(() => expect(alertHandler).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buzz relay reconnect attempts exhausted',
    })));
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(
      'Buzz operator alert delivery failed',
      { error: 'operator sink offline' },
    ));
    await adapter.stop();
  });

  it('rejects future-dated events without poisoning the durable replay cursor', async () => {
    const relay = await createTestRelay();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const future = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
      createdAt: nowSeconds + 3_600,
      content: 'future poison',
    });
    const accepted = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
      createdAt: nowSeconds,
      content: 'current work',
    });
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, future]));
      socket.send(JSON.stringify(['EVENT', subscriptionId, accepted]));
    }, () => undefined);
    const store = new InMemoryBuzzRecoveryStore();
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 2_000,
      recoveryStore: store,
    });
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.loadReplayCursor()).resolves.toBe(nowSeconds));
    await adapter.stop();

    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id: accepted.id });
  });

  it('rejects forged machine parents and reset hops after an authenticated human root', async () => {
    const relay = await createTestRelay();
    const humanSecretKey = generateSecretKey();
    const humanPubkey = getPublicKey(humanSecretKey);
    const humanRoot = signStreamEvent({
      secretKey: humanSecretKey,
      companionPubkey: relay.companionPubkey,
      content: 'Please investigate this.',
    });
    let streamSocket: WebSocket | undefined;
    let streamSubscriptionId: string | undefined;
    const forged = signMachineStreamEvent({
      relay,
      hop: 1,
      rootEventId: humanRoot.id,
      parentEventId: '9'.repeat(64),
      content: 'I reset the chain.',
    });
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      streamSocket = socket;
      streamSubscriptionId = subscriptionId;
      socket.send(JSON.stringify(['EVENT', subscriptionId, humanRoot]));
    }, () => {
      if (!streamSocket || !streamSubscriptionId) throw new Error('stream was not ready');
      streamSocket.send(JSON.stringify(['EVENT', streamSubscriptionId, forged]));
    });
    const config = makeConfig(relay);
    config.allowedAuthorPubkeys = [humanPubkey, relay.authorPubkey];
    config.machineAuthorPubkeys = [relay.authorPubkey];
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(config, makeOptions(2_000, log));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'invalid_causal_parent' }),
    ));
    await adapter.stop();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id: humanRoot.id });
  });

  it('cancels an accepted event even when membership persistence is still blocked', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    let membershipSocket: WebSocket | undefined;
    let membershipSubscriptionId: string | undefined;
    let membershipStarted!: () => void;
    const started = new Promise<void>(resolve => { membershipStarted = resolve; });
    let releaseMembership!: () => void;
    const release = new Promise<void>(resolve => { releaseMembership = resolve; });
    class SlowMembershipStore extends InMemoryBuzzRecoveryStore {
      override async setMembership(change: Parameters<InMemoryBuzzRecoveryStore['setMembership']>[0]): Promise<void> {
        membershipStarted();
        await release;
        await super.setMembership(change);
      }
    }
    const published: Event[] = [];
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, event => published.push(event), { accepted: true, message: 'stored' }, {
      onMembershipSubscription: (socket, subscriptionId) => {
        membershipSocket = socket;
        membershipSubscriptionId = subscriptionId;
      },
    });
    const log: RuntimeChannelLifecycleLogger = { error: vi.fn(), warn: vi.fn() };
    const adapter = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 2_000,
      recoveryStore: new SlowMembershipStore(),
      log,
    });
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => {
      if (!membershipSocket || !membershipSubscriptionId) throw new Error('membership stream was not ready');
      const removal = finalizeEvent({
        kind: 44_101,
        created_at: Math.floor(Date.now() / 1_000) + 1,
        content: '',
        tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
      }, relay.relaySecretKey);
      membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, removal]));
      await started;
      return responseFor(message);
    });

    await adapter.start();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Buzz autonomous reply terminated without publication',
      expect.objectContaining({ reason: 'turn_cancelled' }),
    ));
    releaseMembership();
    await adapter.stop();

    expect(published).toEqual([]);
  });

  it('registers cancellation before blocked claims and surfaces rejected cleanup on stop', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    let claimStarted!: () => void;
    const started = new Promise<void>(resolve => { claimStarted = resolve; });
    let rejectClaim!: (error: Error) => void;
    const blocked = new Promise<never>((_resolve, reject) => { rejectClaim = reject; });
    class FailingClaimStore extends InMemoryBuzzRecoveryStore {
      override async claimInbound(
        input: Parameters<InMemoryBuzzRecoveryStore['claimInbound']>[0],
      ): ReturnType<InMemoryBuzzRecoveryStore['claimInbound']> {
        claimStarted();
        await blocked;
        return await super.claimInbound(input);
      }
    }
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, () => undefined);
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 2_000,
      recoveryStore: new FailingClaimStore(),
    });
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await started;
    const stopping = adapter.stop();
    rejectClaim(new Error('claim cleanup failed'));
    await expect(stopping).rejects.toThrow('Buzz cancelled turn cleanup failed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('prevents cognition when shutdown occurs while an inbound claim is blocked', async () => {
    const relay = await createTestRelay();
    const inbound = signStreamEvent({
      secretKey: relay.authorSecretKey,
      companionPubkey: relay.companionPubkey,
    });
    let claimStarted!: () => void;
    const started = new Promise<void>(resolve => { claimStarted = resolve; });
    let releaseClaim!: () => void;
    const blocked = new Promise<void>(resolve => { releaseClaim = resolve; });
    class BlockingClaimStore extends InMemoryBuzzRecoveryStore {
      override async claimInbound(
        input: Parameters<InMemoryBuzzRecoveryStore['claimInbound']>[0],
      ): ReturnType<InMemoryBuzzRecoveryStore['claimInbound']> {
        claimStarted();
        await blocked;
        return await super.claimInbound(input);
      }
    }
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      socket.send(JSON.stringify(['EVENT', subscriptionId, inbound]));
    }, () => undefined);
    const handler = vi.fn(async (message: SubstrateMessage) => responseFor(message));
    const adapter = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 2_000,
      recoveryStore: new BlockingClaimStore(),
    });
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(handler);

    await adapter.start();
    await started;
    const stopping = adapter.stop();
    releaseClaim();
    await stopping;
    expect(handler).not.toHaveBeenCalled();
  });

  it('terminates and bounds reconnects when membership lifecycle persistence fails', async () => {
    const relay = await createTestRelay();
    let membershipSocket: WebSocket | undefined;
    let membershipSubscriptionId: string | undefined;
    class FailingMembershipStore extends InMemoryBuzzRecoveryStore {
      override async setMembership(): Promise<void> {
        throw new Error('membership persistence offline');
      }
    }
    startAuthenticatedRelay(relay, (_socket) => {
      if (!membershipSocket || !membershipSubscriptionId) return;
      const removal = finalizeEvent({
        kind: 44_101,
        created_at: Math.floor(Date.now() / 1_000) + 1,
        content: '',
        tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
      }, relay.relaySecretKey);
      membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, removal]));
    }, () => undefined, { accepted: true, message: 'stored' }, {
      onMembershipSubscription: (socket, subscriptionId) => {
        membershipSocket = socket;
        membershipSubscriptionId = subscriptionId;
      },
    });
    const alerts = vi.fn(async () => undefined);
    const adapter = new BuzzAdapter(makeConfig(relay), {
      shutdownTimeoutMs: 100,
      recoveryStore: new FailingMembershipStore(),
    });
    adapter.onOperatorAlert(alerts);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    await vi.waitFor(() => expect(alerts).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buzz relay reconnect attempts exhausted',
    })));
    await adapter.stop();
    expect(alerts).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buzz message processing failed',
      message: 'membership persistence offline',
    }));
  });

  it('does not mistake an unacknowledged old close for closure of its replacement stream', async () => {
    const relay = await createTestRelay();
    let membershipSocket: WebSocket | undefined;
    let membershipSubscriptionId: string | undefined;
    let streamCount = 0;
    startAuthenticatedRelay(relay, (socket, subscriptionId) => {
      streamCount += 1;
      if (streamCount % 2 === 0) {
        socket.send(JSON.stringify(['CLOSED', subscriptionId, 'required stream failed']));
        return;
      }
      if (!membershipSocket || !membershipSubscriptionId) return;
      const createdAt = Math.floor(Date.now() / 1_000);
      const removal = finalizeEvent({
        kind: 44_101,
        created_at: createdAt + 1,
        content: '',
        tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
      }, relay.relaySecretKey);
      const addition = finalizeEvent({
        kind: 44_100,
        created_at: createdAt + 2,
        content: '',
        tags: [['p', relay.companionPubkey], ['h', CHANNEL_ID]],
      }, relay.relaySecretKey);
      membershipSocket.send(JSON.stringify(['EVENT', membershipSubscriptionId, removal]));
      setTimeout(() => {
        membershipSocket?.send(JSON.stringify(['EVENT', membershipSubscriptionId, addition]));
      }, 10);
    }, () => undefined, { accepted: true, message: 'stored' }, {
      acknowledgeClose: false,
      onMembershipSubscription: (socket, subscriptionId) => {
        membershipSocket = socket;
        membershipSubscriptionId = subscriptionId;
      },
    });
    const alerts = vi.fn(async () => undefined);
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(100));
    adapter.onOperatorAlert(alerts);
    adapter.onMessage(async message => responseFor(message));

    await adapter.start();
    await vi.waitFor(() => expect(alerts).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buzz relay reconnect attempts exhausted',
    })));
    await adapter.stop();
    expect(streamCount).toBeGreaterThanOrEqual(4);
  });

  it('rejects generic top-level outbound outside an authenticated Stream trigger', async () => {
    const relay = await createTestRelay();
    const adapter = new BuzzAdapter(makeConfig(relay), makeOptions(2_000));

    await expect(adapter.send(
      `buzz:${encodeURIComponent(relay.url)}:${CHANNEL_ID}`,
      'unbound scheduled thought',
    )).rejects.toThrow('Buzz top-level outbound is not supported by the Stream mention tracer');
  });
});
