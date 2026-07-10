import { describe, expect, it } from 'vitest';
import { buildSatelliteHello, PSFN_SATELLITE_MOBILE_CHAT_APP_NAME } from './auth.js';
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
  it('builds the mobile chat app satellite principal', () => {
    expect(buildSatelliteHello()).toEqual({
      type: 'hello',
      deviceId: 'psfn-satellite-mobile-chat-app',
      deviceName: PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
      sessionId: 'psfn-satellite-mobile-chat-app',
      satelliteId: 'psfn-satellite-mobile-chat-app',
      satelliteName: PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
      capabilities: {
        input: ['text'],
        output: ['text', 'subtitle', 'artifact', 'tool_activity'],
        control: ['interrupt', 'presence', 'session_attach', 'approvals'],
        safety: ['confirmation_required', 'local_only'],
      },
    });
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
      deviceName: PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
      satelliteName: PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
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
      identity: {
        source: 'framework',
        companion: { id: 'companion-1', name: 'Purrsephone' },
      },
    });
    await flushAsyncMessage();

    expect(client.snapshot().ready).toBe(true);
    expect(client.snapshot().session.identity?.companion?.name).toBe('Purrsephone');
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
