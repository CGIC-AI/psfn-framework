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
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { BuzzAdapter, type BuzzAdapterConfig } from './adapter.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CHANNEL_ID = '33333333-3333-4333-8333-333333333333';

interface TestRelay {
  server: WebSocketServer;
  url: string;
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
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
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
    companionId: COMPANION_ID,
    privateKey: Buffer.from(relay.companionSecretKey).toString('hex'),
    channelIds: [CHANNEL_ID],
    allowedAuthorPubkeys: [relay.authorPubkey],
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
  extraTags?: string[][];
}): Event {
  return finalizeEvent({
    kind: input.kind ?? 9,
    created_at: Math.floor(Date.now() / 1_000),
    content: input.content ?? 'Please take this work.',
    tags: [
      ['h', input.channelId ?? CHANNEL_ID],
      ...(input.companionPubkey ? [['p', input.companionPubkey]] : []),
      ...(input.extraTags ?? []),
    ],
  }, input.secretKey);
}

function startAuthenticatedRelay(
  relay: TestRelay,
  onSubscribed: (socket: WebSocket, subscriptionId: string) => void,
  onPublished: (event: Event) => void,
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
        socket.send(JSON.stringify(['OK', event.id, true, 'stored']));
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
    const adapter = new BuzzAdapter(makeConfig(relay), { shutdownTimeoutMs: 2_000 });
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
          channel: { scope: 'group', channelId: CHANNEL_ID },
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
    const adapter = new BuzzAdapter(makeConfig(relay), { shutdownTimeoutMs: 2_000 });
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
    const adapter = new BuzzAdapter(makeConfig(relay), { shutdownTimeoutMs: 2_000 });
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async message => responseFor(message));

    await expect(adapter.start()).rejects.toThrow(
      'Buzz relay rejected NIP-42 authentication: membership required',
    );
    await adapter.stop();
  });
});
