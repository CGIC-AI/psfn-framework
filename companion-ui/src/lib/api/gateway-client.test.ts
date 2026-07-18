import { describe, expect, it } from 'vitest';
import type { SatelliteHubWebSocketLike } from './client.js';
import { HubStreamStore } from '../stream/hub-stream.js';
import { CompanionGatewayClient } from './gateway-client.js';

class FakeSocket implements SatelliteHubWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<readonly [number | undefined, string | undefined]> = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
    this.dispatch('close');
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  message(payload: unknown): void {
    this.dispatch('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.dispatch('close', { code });
  }

  private dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const READY = Object.freeze({
  schemaVersion: 1,
  type: 'session.ready',
  device: { id: 'office-display', label: 'Office display' },
  place: { id: 'office', label: 'Office' },
  capabilities: ['text', 'audio_output', 'touch'],
  telemetryScopes: ['status', 'approvals', 'artifacts', 'tool_activity'],
  eventCapabilities: ['approvals.v2'],
});

async function connectClient(socket: FakeSocket, requestIds = ['request-1']) {
  const client = new CompanionGatewayClient({
    url: 'wss://fleet.example.test/companion-ui/companions/11111111-1111-4111-8111-111111111111/ws',
    webSocketFactory: () => socket,
    requestIdFactory: () => requestIds.shift() ?? 'request-fallback',
  });
  const connecting = client.connect();
  socket.open();
  expect(socket.sent.map(frame => JSON.parse(frame))).toEqual([{
    schemaVersion: 1,
    type: 'session.configure',
    eventCapabilities: ['approvals.v2'],
  }]);
  socket.message(READY);
  await connecting;
  socket.sent.length = 0;
  return client;
}

describe('CompanionGatewayClient', () => {
  it('waits for exact server attachment metadata and emits no legacy hello or browser authority', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket);

    expect(client.snapshot()).toMatchObject({
      state: 'ready',
      ready: true,
      session: {
        deviceId: 'office-display',
        deviceName: 'Office display',
        place: { id: 'office', name: 'Office' },
        capabilities: {
          input: ['text'],
          output: ['text', 'streamed_audio', 'artifact', 'tool_activity'],
          control: ['interrupt', 'approvals', 'touch'],
        },
      },
    });
    expect(client.snapshot().session).not.toHaveProperty('sessionId');
    expect(client.snapshot().session).not.toHaveProperty('channelId');
    expect(socket.sent).toEqual([]);
  });

  it('sends exact action frames and correlates server results without retaining channel authority', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket, ['request-interact-1']);
    const inbound: unknown[] = [];
    client.on('inbound', event => inbound.push(event.message));

    client.sendUserText('  hello companion  ');

    expect(socket.sent.map(frame => JSON.parse(frame))).toEqual([{
      schemaVersion: 1,
      requestId: 'request-interact-1',
      action: 'companion.interact',
      resource: 'conversation.interact',
      body: { content: 'hello companion' },
    }]);
    expect(socket.sent[0]).not.toMatch(/deviceId|placeId|sessionId|channelId|credential|assertion|embodiment/u);
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'request-interact-1',
      ok: true,
      result: {
        content: 'hello human',
        channelId: 'server-owned-channel',
        inputTokens: 3,
        outputTokens: 4,
      },
    });
    await flushAsyncMessage();

    expect(inbound).toEqual([
      { type: 'message', data: { role: 'user', content: 'hello companion', final: true } },
      { type: 'message', data: { role: 'assistant', content: 'hello human', final: true } },
    ]);
    expect(JSON.stringify(client.snapshot())).not.toContain('server-owned-channel');
  });

  it('uses only server-listed shards and keeps direct chat provenance on the exact selector', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket, [
      'list-1',
      'history-1',
      'interaction-1',
      'interrupt-1',
    ]);
    const inbound: unknown[] = [];
    client.on('inbound', event => inbound.push(event.message));

    expect(() => client.selectShard('shard-forged')).toThrow(/not in the server directory/u);
    client.refreshShards();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: 'list-1',
      action: 'companion.read',
      resource: 'shards.list',
      body: {},
    });
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'list-1',
      ok: true,
      result: [{
        shardId: 'shard-live-1',
        label: 'Research',
        purpose: 'Compare bounded sources',
        availability: 'available',
        startedAt: 1,
      }],
    });
    await flushAsyncMessage();

    client.selectShard('shard-live-1');
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: 'history-1',
      action: 'companion.read',
      resource: 'shards.history',
      body: { shardId: 'shard-live-1' },
    });
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'history-1',
      ok: true,
      result: [{
        id: 'prior-1',
        role: 'assistant',
        content: 'Prior bounded response',
        createdAt: 2,
        attribution: {
          parentCompanionId: '11111111-1111-4111-8111-111111111111',
          shardId: 'shard-live-1',
        },
      }],
    });
    await flushAsyncMessage();
    expect(client.snapshot().session.activeShardId).toBe('shard-live-1');

    client.sendUserText('ask exact shard');
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: 'interaction-1',
      action: 'companion.interact',
      resource: 'shards.interact',
      body: { shardId: 'shard-live-1', content: 'ask exact shard' },
    });
    client.interrupt();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: 'interrupt-1',
      resource: 'shards.interrupt',
      body: { shardId: 'shard-live-1', interactionId: 'interaction-1' },
    });
    expect(inbound).toContainEqual({
      type: 'message',
      data: { role: 'assistant', content: 'Prior bounded response', final: true },
    });
  });

  it('binds an in-flight response and interrupt to its originating shard across selection changes', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket, [
      'list-1',
      'history-a',
      'interaction-a',
      'history-b',
      'interrupt-a',
    ]);
    const inbound: unknown[] = [];
    client.on('inbound', event => inbound.push(event.message));
    client.refreshShards();
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'list-1',
      ok: true,
      result: ['a', 'b'].map(shardId => ({
        shardId,
        label: `Shard ${shardId}`,
        purpose: 'Bounded task',
        availability: 'available',
        startedAt: 1,
      })),
    });
    await flushAsyncMessage();

    client.selectShard('a');
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'history-a',
      ok: true,
      result: [],
    });
    await flushAsyncMessage();
    client.sendUserText('question for A');

    client.selectShard('b');
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'history-b',
      ok: true,
      result: [],
    });
    await flushAsyncMessage();
    client.interrupt();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: 'interrupt-a',
      resource: 'shards.interrupt',
      body: { shardId: 'a', interactionId: 'interaction-a' },
    });
    socket.message({
      schemaVersion: 1,
      type: 'result',
      requestId: 'interaction-a',
      ok: true,
      result: {
        content: 'answer from A',
        channelId: 'shard:a:human',
        inputTokens: 1,
        outputTokens: 1,
        attribution: {
          parentCompanionId: '11111111-1111-4111-8111-111111111111',
          shardId: 'a',
        },
      },
    });
    await flushAsyncMessage();

    expect(inbound).not.toContainEqual({
      type: 'message',
      data: { role: 'assistant', content: 'answer from A', final: true },
    });
  });

  it('clears the session and authority-bound approval state immediately on an authority close', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket);
    const store = new HubStreamStore(client);

    socket.message({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'approval.requested',
        data: {
          id: 'approval-revoked',
          title: 'write file: redacted',
          requestedAt: '2026-07-17T00:00:00.000Z',
          redactedContext: 'Needs permission',
          status: 'pending',
          sourceSystem: 'tool-access',
          attribution: {
            parentId: '11111111-1111-4111-8111-111111111111',
            parentLabel: 'Companion',
          },
          action: 'write file',
          scope: 'redacted',
          reason: 'Needs permission',
          grantMode: { kind: 'once' },
        },
      },
    });
    socket.message({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'approval.resolved',
        data: {
          id: 'approval-history',
          status: 'denied',
          resolvedAt: '2026-07-17T00:00:01.000Z',
        },
      },
    });
    await flushAsyncMessage();
    expect(store.snapshot().approvals).toHaveLength(1);
    expect(store.snapshot().approvalResolutions).toHaveProperty('approval-history');

    socket.serverClose(4401);

    expect(client.snapshot().session).toEqual({});
    expect(store.snapshot()).toMatchObject({
      connection: 'disconnected',
      session: null,
      approvals: [],
      approvalResolutions: {},
    });
    store.destroy();
  });

  it.each([
    ['discriminator-only ready', { schemaVersion: 1, type: 'session.ready' }],
    ['ready with injected authority', { ...READY, sessionId: 'forged' }],
    ['ready with unknown capability', { ...READY, capabilities: ['text', 'root_shell'] }],
    ['ready with malformed presentation', { ...READY, device: { id: 'display', label: '', credential: 'x' } }],
  ])('rejects %s', async (_label, malformed) => {
    const socket = new FakeSocket();
    const client = new CompanionGatewayClient({
      url: 'wss://fleet.example.test/companion-ui/companions/11111111-1111-4111-8111-111111111111/ws',
      webSocketFactory: () => socket,
      handshakeTimeoutMs: 1_000,
    });
    const connecting = client.connect();
    socket.open();
    socket.message(malformed);

    await expect(connecting).rejects.toThrow(/closed before attachment was ready/u);
    expect(socket.closeCalls).toContainEqual([1002, 'Protocol error']);
  });

  it('fails closed on replayed, uncorrelated, or structurally incomplete results', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket, ['request-1']);
    client.sendUserText('hello');
    socket.message({ schemaVersion: 1, type: 'result', requestId: 'request-replayed', ok: true });
    await flushAsyncMessage();

    expect(socket.closeCalls).toContainEqual([1002, 'Protocol error']);
  });

  it('uses exact confirmation, artifact, interrupt, and touch action families', async () => {
    const socket = new FakeSocket();
    const client = await connectClient(socket, ['interaction-1', 'approval-1', 'touch-1']);
    client.sendUserText('hello');
    client.interrupt();
    client.sendApprovalDecision('approval-id', 'deny');
    client.sendArtifactPreviewRequest('preview-1', 'artifact-id');
    client.sendTouchInteraction({ kind: 'headpat', region: 'head', count: 2, durationMs: 20 });

    expect(socket.sent.map(frame => JSON.parse(frame))).toEqual([
      expect.objectContaining({ requestId: 'interaction-1', resource: 'conversation.interact' }),
      {
        schemaVersion: 1,
        requestId: 'approval-1',
        action: 'companion.interact',
        resource: 'conversation.interrupt',
        body: { interactionId: 'interaction-1' },
      },
      {
        schemaVersion: 1,
        requestId: 'touch-1',
        action: 'confirmations.resolve',
        resource: 'confirmations.resolve',
        body: { id: 'approval-id', decision: 'deny' },
      },
      {
        schemaVersion: 1,
        requestId: 'preview-1',
        action: 'artifacts.read',
        resource: 'artifact.preview',
        body: { id: 'artifact-id' },
      },
      {
        schemaVersion: 1,
        requestId: 'request-fallback',
        action: 'companion.interact',
        resource: 'conversation.touch',
        body: { region: 'head', count: 2, durationMs: 20 },
      },
    ]);
  });
});

function flushAsyncMessage(): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, 0));
}
