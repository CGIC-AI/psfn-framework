import { describe, expect, it } from 'vitest';
import { buildSatelliteHello } from './auth.js';
import {
  resolveHubWebSocketUrl,
  SatelliteHubClient,
  type SatelliteHubWebSocketLike,
} from './client.js';

class FakeSocket implements SatelliteHubWebSocketLike {
  public readyState = 0;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  message(payload: unknown): void {
    this.dispatch('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  private dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('satellite hub auth', () => {
  it('advertises only presentation capabilities and no browser authority', () => {
    expect(buildSatelliteHello()).toEqual({
      type: 'hello',
      capabilities: {
        input: ['text'],
        output: ['text', 'subtitle', 'artifact', 'tool_activity'],
        control: ['interrupt', 'presence', 'session_attach', 'approvals', 'touch'],
        safety: ['confirmation_required', 'local_only'],
      },
      eventCapabilities: ['approvals.v2'],
    });
    expect(Object.keys(buildSatelliteHello()).sort()).toEqual([
      'capabilities',
      'eventCapabilities',
      'type',
    ]);
  });
});

describe('satellite hub websocket client', () => {
  it('connects to the hub websocket and sends hello immediately after open', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });
    const states: string[] = [];
    client.on('state', (event) => states.push(event.current));

    const connecting = client.connect();
    socket.open();
    await connecting;

    expect(states).toEqual(['connecting', 'connected']);
    expect(JSON.parse(socket.sent[0] ?? '')).toMatchObject({
      type: 'hello',
      capabilities: expect.any(Object),
    });
  });

  it('surfaces session identity from hello ack without owning it', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://hub.local:8787/',
      webSocketFactory: () => socket,
    });
    const sessions: unknown[] = [];
    client.on('session', (session) => sessions.push(session));

    const connecting = client.connect();
    socket.open();
    await connecting;
    socket.message({
      type: 'hello.ack',
      sessionId: 'session-1',
      channelId: 'satellite.endpoint:session-1',
      deviceId: 'phone',
      deviceName: 'Phone',
      satelliteId: 'phone',
      satelliteName: 'Phone',
      capabilities: { input: ['text'], output: ['text'] },
      eventCapabilities: ['approvals.v2'],
      place: { id: 'office', name: 'Office' },
      identity: {
        source: 'framework',
        companion: { id: 'companion-1', name: 'Purrsephone' },
      },
    });
    await flushAsyncMessage();

    expect(client.snapshot().ready).toBe(true);
    expect(client.snapshot().session.identity?.companion?.name).toBe('Purrsephone');
    expect(client.snapshot().session.place).toEqual({ id: 'office', name: 'Office' });
    expect(client.snapshot().session.eventCapabilities).toEqual(['approvals.v2']);
    expect(sessions).toHaveLength(1);
  });

  it('sends trimmed typed user text over the hub protocol', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });

    const connecting = client.connect();
    socket.open();
    await connecting;
    client.sendUserText('  hello hub  ', { interrupt: false });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: 'user.text',
      text: 'hello hub',
      interrupt: false,
    });
  });

  it('sends a typed headpat interaction over the hub protocol', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });

    const connecting = client.connect();
    socket.open();
    await connecting;
    client.sendTouchInteraction({ kind: 'headpat', region: 'head', count: 12, durationMs: 1_100 });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: 'touch.interaction',
      kind: 'headpat',
      region: 'head',
      count: 12,
      durationMs: 1_100,
    });
  });

  it('sends raw coordinates to the hub but redacts them from the outbound telemetry event', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });
    const outbound: unknown[] = [];
    client.on('outbound', (event) => outbound.push(event.message));

    const connecting = client.connect();
    socket.open();
    await connecting;

    expect(client.supportsDeviceLocation()).toBe(true);
    client.sendDeviceLocation({ lat: 37.42, lon: -122.08, accuracyM: 12, timestamp: 1_700_000_000_000 });

    // The wire frame to the hub carries the real coordinates (they terminate there).
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: 'device.location',
      lat: 37.42,
      lon: -122.08,
      accuracyM: 12,
      timestamp: 1_700_000_000_000,
    });

    // The telemetry copy (which may be logged) must not carry the coordinates.
    const telemetry = outbound.find(
      (message): message is { type: string; lat: number; lon: number; accuracyM: number } =>
        typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'device.location',
    );
    expect(telemetry).toBeDefined();
    expect(telemetry?.lat).toBe(0);
    expect(telemetry?.lon).toBe(0);
    expect(telemetry?.accuracyM).toBe(12);
    expect(JSON.stringify(outbound)).not.toContain('37.42');
    expect(JSON.stringify(outbound)).not.toContain('-122.08');
  });

  it('rejects unknown inbound hub message types and marks the client unhealthy', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });
    const errors: string[] = [];
    client.on('error', (event) => errors.push(event.message));

    const connecting = client.connect();
    socket.open();
    await connecting;
    socket.message({ type: 'turn.started' });
    await flushAsyncMessage();

    expect(client.snapshot().state).toBe('error');
    expect(errors.at(-1)).toContain('Unknown hub->client message type');
  });

  it('rejects discriminator-only and authority-injected hello acknowledgements', async () => {
    const socket = new FakeSocket();
    const client = new SatelliteHubClient({
      url: 'ws://127.0.0.1:8787/',
      webSocketFactory: () => socket,
    });
    const connecting = client.connect();
    socket.open();
    await connecting;
    socket.message({ type: 'hello.ack', deviceId: 'forged' });
    await flushAsyncMessage();
    expect(client.snapshot().state).toBe('error');
  });
});

describe('hub websocket URL policy', () => {
  it('accepts websocket URLs only', () => {
    expect(resolveHubWebSocketUrl('ws://hub.local:8787/')).toBe('ws://hub.local:8787/');
    expect(resolveHubWebSocketUrl('wss://hub.local/')).toBe('wss://hub.local/');
    expect(() => resolveHubWebSocketUrl('https://hub.local/')).toThrow(/ws: or wss:/);
  });

  it('rejects admin API paths', () => {
    const forbiddenPath = ['api', 'admin', 'events'].join('/');

    expect(() => resolveHubWebSocketUrl(`ws://hub.local/${forbiddenPath}`)).toThrow(/admin/);
  });
});

function flushAsyncMessage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
