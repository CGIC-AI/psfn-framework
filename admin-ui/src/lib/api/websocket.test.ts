import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAdminWebSocketUrl,
  ReconnectingWebSocket,
  type WsConnectionError,
} from './websocket';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('window', {
    location: {
      protocol: 'https:',
      host: 'garden.example.test',
      pathname: '/telemetry',
    },
  });
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAdminWebSocketUrl', () => {
  it('builds same-origin websocket URLs without query-string tokens', () => {
    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
    })).toBe('wss://garden.example.test/api/admin/events');

    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'http:',
      host: '127.0.0.1:10054',
    })).toBe('ws://127.0.0.1:10054/api/admin/events');
  });

  it('binds the websocket to the canonical companion route', () => {
    const companionId = '11111111-1111-4111-8111-111111111111';
    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
      pathname: `/companions/${companionId}/garden/telemetry`,
    })).toBe(
      `wss://garden.example.test/companions/${companionId}/garden/api/admin/events`,
    );
  });

  it('does not append token-like query parameters', () => {
    const url = buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
    });

    expect(url).not.toContain('token=');
    expect(url).not.toContain('?');
  });
});

describe('ReconnectingWebSocket failures', () => {
  it('prepares the browser session credential before opening the socket', async () => {
    let releasePreparation: (() => void) | undefined;
    const prepareConnection = vi.fn(() => new Promise<void>((resolve) => {
      releasePreparation = resolve;
    }));
    const socket = new ReconnectingWebSocket(
      '/api/admin/events',
      60_000,
      prepareConnection,
    );

    socket.connect();
    expect(prepareConnection).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(0);

    releasePreparation?.();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    socket.close();
  });

  it('surfaces the server-authored close code and reason for a rejected upgrade', () => {
    const socket = new ReconnectingWebSocket('/api/admin/events', 60_000);
    const errors: Array<WsConnectionError | null> = [];
    socket.onConnectionError(error => errors.push(error));

    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].emitClose(4404, 'Garden stream unavailable');

    expect(socket.connectionError).toEqual({
      kind: 'close',
      code: 4404,
      reason: 'Garden stream unavailable',
    });
    expect(errors.at(-1)).toEqual(socket.connectionError);
    socket.close();
  });

  it('surfaces permanent companion-scope configuration errors without retrying', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        host: 'garden.example.test',
        pathname: '/fleet',
      },
    });
    const socket = new ReconnectingWebSocket('/api/admin/events', 1);

    socket.connect();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(socket.connectionError).toEqual({
      kind: 'configuration',
      code: null,
      reason: 'Companion data requires an authorized companion route',
    });
  });
});
