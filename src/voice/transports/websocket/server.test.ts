import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeVoiceWireFrame } from './serializer.js';
import { WebSocketVoiceServer } from './server.js';
import { VOICE_WIRE_PROTOCOL, type WebSocketVoiceConnection } from './types.js';

class FakeConnection implements WebSocketVoiceConnection {
  readonly id: string;
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.emitClose();
    this.closedWith = { code, reason };
  });
  readonly send = vi.fn();

  closedWith: { code?: number; reason?: string } | null = null;
  private readonly messageHandlers = new Set<(data: string) => void>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(id: string) {
    this.id = id;
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emitMessage(data: string): void {
    for (const handler of [...this.messageHandlers]) {
      handler(data);
    }
  }

  emitClose(): void {
    for (const handler of [...this.closeHandlers]) {
      handler();
    }
    this.closeHandlers.clear();
  }
}

describe('WebSocketVoiceServer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a session and dispatches connect/stream/end frames in order', () => {
    const connection = new FakeConnection('conn-1');
    const onFrame = vi.fn();
    const onSessionOpen = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024 },
      { onFrame, onSessionOpen },
    );

    server.attach(connection);

    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'conn-1',
    }));
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'conn-1',
      seq: 1,
      audioBase64: 'ZGF0YQ==',
    }));
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.end',
      sessionId: 'conn-1',
    }));

    expect(onSessionOpen).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onFrame).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'conn-1', connectionId: 'conn-1' }),
      expect.objectContaining({ type: 'session.start', sessionId: 'conn-1' }),
    );
    expect(onFrame).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'conn-1', connectionId: 'conn-1' }),
      expect.objectContaining({
        type: 'audio.chunk',
        sessionId: 'conn-1',
        seq: 1,
        audioBase64: 'ZGF0YQ==',
      }),
    );
    expect(onFrame).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: 'conn-1', connectionId: 'conn-1' }),
      expect.objectContaining({ type: 'session.end', sessionId: 'conn-1' }),
    );
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('dispatches interrupt frames without closing the session', () => {
    const connection = new FakeConnection('conn-1b');
    const onFrame = vi.fn();
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024 },
      { onFrame, onSessionClose },
    );

    server.attach(connection);
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'interrupt',
      sessionId: 'conn-1b',
      reason: 'barge-in',
    }));

    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1b', connectionId: 'conn-1b' }),
      expect.objectContaining({ type: 'interrupt', sessionId: 'conn-1b', reason: 'barge-in' }),
    );
    expect(connection.close).not.toHaveBeenCalled();
    expect(onSessionClose).not.toHaveBeenCalled();
  });

  it('records client disconnects without issuing a server close frame', () => {
    const connection = new FakeConnection('conn-1c');
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024 },
      { onSessionClose },
    );

    server.attach(connection);
    connection.emitClose();

    expect(connection.close).not.toHaveBeenCalled();
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1c', connectionId: 'conn-1c' }),
      'client_disconnect',
    );
  });

  it('closes inactive sessions on timeout', async () => {
    const connection = new FakeConnection('conn-2');
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 100, maxFrameBytes: 1024 },
      { onSessionClose },
    );

    server.attach(connection);
    await vi.advanceTimersByTimeAsync(101);

    expect(connection.close).toHaveBeenCalledWith(4000, 'session timeout');
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-2' }),
      'timeout',
    );
  });

  it('rejects oversize frames with close code 1009', () => {
    const connection = new FakeConnection('conn-3');
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 32 },
      { onSessionClose },
    );

    server.attach(connection);
    connection.emitMessage('x'.repeat(128));

    expect(connection.close).toHaveBeenCalledWith(1009, 'frame too large');
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-3' }),
      'decode_error',
    );
  });
});
