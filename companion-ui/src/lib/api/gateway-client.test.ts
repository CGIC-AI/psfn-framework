import { describe, expect, it } from 'vitest';
import type { SatelliteHubWebSocketLike } from './client.js';
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
