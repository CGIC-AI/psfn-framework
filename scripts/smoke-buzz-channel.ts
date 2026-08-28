import { randomUUID } from 'node:crypto';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
} from 'nostr-tools';
import { WebSocket, type RawData } from 'ws';
import { BuzzAdapter } from '../src/channels/buzz/adapter.js';
import type { SubstrateMessage } from '../src/shared/contracts/runtime.js';

const NIP_42_AUTH_KIND = 22_242;
const SMOKE_TIMEOUT_MS = 10_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), SMOKE_TIMEOUT_MS);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class SmokeNostrClient {
  private readonly socket: WebSocket;
  private readonly secretKey: Uint8Array;
  private readonly relayUrl: string;
  private readonly authenticated = deferred<void>();
  private readonly pendingPublishes = new Map<string, Deferred<void>>();
  private readonly subscriptions = new Map<string, (event: NostrEvent) => void>();
  private authEventId: string | null = null;

  constructor(relayUrl: string, secretKey: Uint8Array) {
    this.relayUrl = relayUrl;
    this.secretKey = secretKey;
    this.socket = new WebSocket(relayUrl);
    this.socket.on('message', raw => this.handleFrame(raw));
    this.socket.on('error', error => this.authenticated.reject(error));
    this.socket.on('close', () => this.authenticated.reject(new Error('Buzz smoke client connection closed')));
  }

  async connect(): Promise<void> {
    await withTimeout(this.authenticated.promise, 'Timed out authenticating Buzz smoke client');
  }

  async publish(event: NostrEvent): Promise<void> {
    const result = deferred<void>();
    this.pendingPublishes.set(event.id, result);
    this.send(['EVENT', event]);
    await withTimeout(result.promise, `Timed out publishing Buzz smoke event ${event.id}`);
  }

  subscribe(filter: Record<string, unknown>, onEvent: (event: NostrEvent) => void): string {
    const id = `psfn-smoke-${randomUUID()}`;
    this.subscriptions.set(id, onEvent);
    this.send(['REQ', id, filter]);
    return id;
  }

  close(): void {
    for (const id of this.subscriptions.keys()) this.send(['CLOSE', id]);
    this.socket.close();
  }

  private handleFrame(raw: RawData): void {
    const frame = JSON.parse(raw.toString()) as unknown[];
    if (frame[0] === 'AUTH') {
      const challenge = frame[1];
      if (typeof challenge !== 'string') throw new Error('Buzz smoke relay sent an invalid AUTH challenge');
      const event = finalizeEvent({
        kind: NIP_42_AUTH_KIND,
        created_at: Math.floor(Date.now() / 1_000),
        content: '',
        tags: [['relay', this.relayUrl], ['challenge', challenge]],
      }, this.secretKey);
      this.authEventId = event.id;
      this.send(['AUTH', event]);
      return;
    }
    if (frame[0] === 'OK') {
      const eventId = frame[1];
      const accepted = frame[2];
      const message = typeof frame[3] === 'string' ? frame[3] : 'no relay reason';
      if (eventId === this.authEventId) {
        if (accepted === true) this.authenticated.resolve();
        else this.authenticated.reject(new Error(`Buzz smoke authentication rejected: ${message}`));
        return;
      }
      if (typeof eventId !== 'string') return;
      const pending = this.pendingPublishes.get(eventId);
      if (!pending) return;
      this.pendingPublishes.delete(eventId);
      if (accepted === true) pending.resolve();
      else pending.reject(new Error(`Buzz smoke event rejected: ${message}`));
      return;
    }
    if (frame[0] === 'EVENT' && typeof frame[1] === 'string') {
      const event = frame[2];
      if (event && typeof event === 'object' && verifyEvent(event as NostrEvent)) {
        this.subscriptions.get(frame[1])?.(event as NostrEvent);
      }
    }
  }

  private send(frame: unknown[]): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Buzz smoke WebSocket is not open');
    this.socket.send(JSON.stringify(frame));
  }
}

async function main(): Promise<void> {
  const relayUrl = process.env.BUZZ_LIVE_RELAY_URL?.trim();
  if (!relayUrl) throw new Error('BUZZ_LIVE_RELAY_URL is required');
  const companionSecretKey = generateSecretKey();
  const companionPubkey = getPublicKey(companionSecretKey);
  const authorSecretKey = generateSecretKey();
  const authorPubkey = getPublicKey(authorSecretKey);
  const channelId = randomUUID();
  const authorClient = new SmokeNostrClient(relayUrl, authorSecretKey);
  await authorClient.connect();

  const createChannel = finalizeEvent({
    kind: 9_007,
    created_at: Math.floor(Date.now() / 1_000),
    content: '',
    tags: [
      ['h', channelId],
      ['name', `psfn-buzz-smoke-${channelId}`],
      ['channel_type', 'stream'],
      ['visibility', 'open'],
    ],
  }, authorSecretKey);
  await authorClient.publish(createChannel);

  const reply = deferred<NostrEvent>();
  authorClient.subscribe({
    kinds: [9],
    authors: [companionPubkey],
    '#h': [channelId],
    since: Math.floor(Date.now() / 1_000),
  }, event => reply.resolve(event));

  const handled = deferred<SubstrateMessage>();
  const adapter = new BuzzAdapter({
    enabled: true,
    relayUrl,
    companionId: COMPANION_ID,
    privateKey: Buffer.from(companionSecretKey).toString('hex'),
    channelIds: [channelId],
    allowedAuthorPubkeys: [authorPubkey],
  }, { shutdownTimeoutMs: SMOKE_TIMEOUT_MS });
  adapter.onOperatorAlert(async alert => {
    throw new Error(`${alert.title}: ${alert.message}`);
  });
  adapter.onMessage(async message => {
    handled.resolve(message);
    return {
      content: 'PSFN Buzz round trip complete.',
      channelId: message.channelId,
      metadata: { model: 'smoke', inputTokens: 0, outputTokens: 0, durationMs: 0 },
    };
  });

  let mention: NostrEvent | null = null;
  try {
    await adapter.start();
    mention = finalizeEvent({
      kind: 9,
      created_at: Math.floor(Date.now() / 1_000),
      content: 'Run the PSFN Buzz live smoke.',
      tags: [['h', channelId], ['p', companionPubkey]],
    }, authorSecretKey);
    await authorClient.publish(mention);
    const [message, response] = await Promise.all([
      withTimeout(handled.promise, 'Timed out waiting for Buzz message to enter PSFN'),
      withTimeout(reply.promise, 'Timed out waiting for PSFN Buzz reply'),
    ]);
    if (message.id !== mention.id || message.content !== mention.content) {
      throw new Error('Buzz smoke inbound message did not preserve the signed trigger');
    }
    if (
      response.content !== 'PSFN Buzz round trip complete.'
      || !response.tags.some(tag => tag[0] === 'e' && tag[1] === mention?.id && tag[3] === 'reply')
      || !response.tags.some(tag => tag[0] === 'p' && tag[1] === authorPubkey)
    ) {
      throw new Error('Buzz smoke reply did not preserve content, author mention, and reply anchor');
    }
    console.log(`Buzz channel smoke passed for room ${channelId}`);
  } finally {
    await adapter.stop();
    const deleteChannel = finalizeEvent({
      kind: 9_008,
      created_at: Math.floor(Date.now() / 1_000),
      content: '',
      tags: [['h', channelId]],
    }, authorSecretKey);
    await authorClient.publish(deleteChannel).catch(() => undefined);
    authorClient.close();
  }
}

await main();
