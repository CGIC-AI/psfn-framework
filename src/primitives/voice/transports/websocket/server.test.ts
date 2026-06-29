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

  it('opens a session and dispatches connect/stream/end frames in order', async () => {
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
    await waitForCondition(() => onFrame.mock.calls.length === 3 && onSessionOpen.mock.calls.length === 1);

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

  it('dispatches interrupt frames without closing the session', async () => {
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
    await waitForCondition(() => onFrame.mock.calls.length === 1);

    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1b', connectionId: 'conn-1b' }),
      expect.objectContaining({ type: 'interrupt', sessionId: 'conn-1b', reason: 'barge-in' }),
    );
    expect(connection.close).not.toHaveBeenCalled();
    expect(onSessionClose).not.toHaveBeenCalled();
  });

  it('records client disconnects without issuing a server close frame', async () => {
    const connection = new FakeConnection('conn-1c');
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024 },
      { onSessionClose },
    );

    server.attach(connection);
    connection.emitClose();
    await waitForCondition(() => onSessionClose.mock.calls.length === 1);

    expect(connection.close).not.toHaveBeenCalled();
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1c', connectionId: 'conn-1c' }),
      'client_disconnect',
    );
  });

  it('serializes frame dispatch per connection', async () => {
    const connection = new FakeConnection('conn-serial');
    const firstFrameGate = createDeferred();
    const secondFrameGate = createDeferred();
    const onFrame = vi.fn(async (_session, frame) => {
      if (frame.type === 'session.start') {
        await firstFrameGate.promise;
        return;
      }
      await secondFrameGate.promise;
    });
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024, maxPendingFrames: 4 },
      { onFrame },
    );

    server.attach(connection);
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'conn-serial',
    }));
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'ping',
      sessionId: 'conn-serial',
    }));

    await flushPromises();
    expect(onFrame).toHaveBeenCalledTimes(1);

    firstFrameGate.resolve();
    await flushPromises();
    expect(onFrame).toHaveBeenCalledTimes(2);

    secondFrameGate.resolve();
    await flushPromises();
  });

  it('drops queued frames when the client disconnects during frame processing', async () => {
    const connection = new FakeConnection('conn-close-race');
    const firstFrameGate = createDeferred();
    const onFrame = vi.fn(async () => {
      await firstFrameGate.promise;
    });
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024, maxPendingFrames: 4 },
      { onFrame, onSessionClose },
    );

    server.attach(connection);
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'conn-close-race',
    }));
    connection.emitMessage(serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'ping',
      sessionId: 'conn-close-race',
    }));

    await flushPromises();
    expect(onFrame).toHaveBeenCalledTimes(1);

    connection.emitClose();
    await waitForCondition(() => onSessionClose.mock.calls.length === 1);

    firstFrameGate.resolve();
    await flushPromises();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-close-race', connectionId: 'conn-close-race' }),
      'client_disconnect',
    );
  });

  it('applies backpressure when pending frame queue overflows', async () => {
    const connection = new FakeConnection('conn-backpressure');
    const holdFirstFrame = createDeferred();
    const onFrame = vi.fn(async () => {
      await holdFirstFrame.promise;
    });
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 1024, maxPendingFrames: 2 },
      { onFrame, onSessionClose },
    );

    server.attach(connection);
    for (let index = 0; index < 4; index += 1) {
      connection.emitMessage(serializeVoiceWireFrame({
        wire: VOICE_WIRE_PROTOCOL,
        type: index === 0 ? 'session.start' : 'ping',
        sessionId: 'conn-backpressure',
      }));
    }

    await flushPromises();
    expect(connection.close).toHaveBeenCalledWith(1008, 'frame queue overflow');
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-backpressure' }),
      'decode_error',
    );

    holdFirstFrame.resolve();
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
    await waitForCondition(() => onSessionClose.mock.calls.length === 1);

    expect(connection.close).toHaveBeenCalledWith(4000, 'session timeout');
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-2' }),
      'timeout',
    );
  });

  it('rejects oversize frames with close code 1009', async () => {
    const connection = new FakeConnection('conn-3');
    const onSessionClose = vi.fn();
    const server = new WebSocketVoiceServer(
      { sessionTimeoutMs: 5_000, maxFrameBytes: 32 },
      { onSessionClose },
    );

    server.attach(connection);
    connection.emitMessage('x'.repeat(128));
    await waitForCondition(() => onSessionClose.mock.calls.length === 1);

    expect(connection.close).toHaveBeenCalledWith(1009, 'frame too large');
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-3' }),
      'decode_error',
    );
  });
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(condition: () => boolean, maxAttempts = 40): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await flushPromises();
  }

  throw new Error('Condition not met within wait window');
}
