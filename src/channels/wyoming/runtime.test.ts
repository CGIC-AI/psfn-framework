import { describe, expect, it, vi } from 'vitest';
import { WyomingRuntime } from './runtime.js';
import type { WyomingFrame, WyomingTransportSession } from './protocol.js';
import {
  createWyomingHandleServiceAdapter,
  createWyomingServiceRegistry,
} from './services/index.js';

function createTransportSession(connectionId: string): WyomingTransportSession {
  return {
    id: connectionId,
    connectionId,
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };
}

describe('WyomingRuntime', () => {
  it('responds to describe with info payload', async () => {
    const emitted: WyomingFrame[] = [];
    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [{ name: 'handle', version: '1.0.0' }],
      },
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
    });

    await runtime.handleFrame(createTransportSession('conn-1'), { type: 'describe' });

    expect(emitted).toEqual([
      {
        type: 'info',
        data: {
          name: 'psfn-wyoming',
          version: '1.0.0',
          services: [{ name: 'handle', version: '1.0.0', description: undefined, supports: undefined }],
          description: undefined,
        },
      },
    ]);
  });

  it('opens and closes sessions with ack frames', async () => {
    const emitted: WyomingFrame[] = [];
    const onSessionStart = vi.fn();
    const onSessionEnd = vi.fn();

    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
      onSessionStart,
      onSessionEnd,
    });

    const transportSession = createTransportSession('conn-2');
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-a' },
    });

    expect(runtime.getActiveSessionCount()).toBe(1);
    expect(onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-2', sessionId: 'session-a' }),
      expect.objectContaining({ type: 'session.start' }),
    );

    await runtime.handleFrame(transportSession, {
      type: 'session.end',
      data: { session_id: 'session-a' },
    });

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(onSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-2', sessionId: 'session-a' }),
      'session.end',
    );

    const ackEvents = emitted.filter((frame) => frame.type === 'ack');
    expect(ackEvents).toEqual([
      { type: 'ack', data: { event: 'session.start', session_id: 'session-a' } },
      { type: 'ack', data: { event: 'session.end', session_id: 'session-a' } },
    ]);
  });

  it('emits deterministic errors for duplicate and missing sessions', async () => {
    const emitted: WyomingFrame[] = [];
    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
    });

    const transportSession = createTransportSession('conn-3');

    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-x' },
    });
    emitted.length = 0;

    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-x' },
    });
    await runtime.handleFrame(transportSession, {
      type: 'session.end',
      data: { session_id: 'missing' },
    });

    const errors = emitted.filter((frame) => frame.type === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({ code: 'SESSION_ALREADY_EXISTS', event: 'session.start' }),
    }));
    expect(errors[1]).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({ code: 'SESSION_NOT_FOUND', event: 'session.end' }),
    }));
  });

  it('enforces maximum concurrent sessions', async () => {
    const emitted: WyomingFrame[] = [];
    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      maxConcurrentSessions: 1,
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
    });

    await runtime.handleFrame(createTransportSession('conn-4a'), {
      type: 'session.start',
      data: { session_id: 'first' },
    });

    emitted.length = 0;
    await runtime.handleFrame(createTransportSession('conn-4b'), {
      type: 'session.start',
      data: { session_id: 'second' },
    });

    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'SESSION_LIMIT_REACHED' }),
      }),
    ]);
  });

  it('closes all sessions for a connection and emits onSessionEnd once per session', async () => {
    const onSessionEnd = vi.fn();
    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      emitFrame: async () => {},
      onSessionEnd,
    });

    const transportSession = createTransportSession('conn-5');
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-a' },
    });
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-b' },
    });

    expect(runtime.getActiveSessionCount()).toBe(2);

    await runtime.closeConnection('conn-5', 'transport.closed');

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(onSessionEnd).toHaveBeenCalledTimes(2);
    expect(onSessionEnd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId: 'conn-5' }),
      'transport.closed',
    );
    expect(onSessionEnd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ connectionId: 'conn-5' }),
      'transport.closed',
    );
  });

  it('routes unhandled events to runtime callback with resolved session context', async () => {
    const emitted: WyomingFrame[] = [];
    const onUnhandledEvent = vi.fn(async ({ sessionId }) => {
      return {
        type: 'ack',
        data: {
          event: 'audio.chunk',
          session_id: sessionId ?? null,
        },
      };
    });

    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
      onUnhandledEvent,
    });

    const transportSession = createTransportSession('conn-6');
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-z' },
    });

    emitted.length = 0;
    await runtime.handleFrame(transportSession, {
      type: 'audio.chunk',
      data: { session_id: 'session-z' },
      payload: new Uint8Array([9, 9]),
    });

    expect(onUnhandledEvent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-z',
      session: expect.objectContaining({ sessionId: 'session-z' }),
      frame: expect.objectContaining({ type: 'audio.chunk' }),
    }));

    expect(emitted).toEqual([
      {
        type: 'ack',
        data: {
          event: 'audio.chunk',
          session_id: 'session-z',
        },
      },
    ]);
  });

  it('routes service events through Wyoming service registry', async () => {
    const emitted: WyomingFrame[] = [];
    const handleMessage = vi.fn(async () => ({
      content: 'handled response',
      channelId: 'api:wyoming:unknown:conn-7',
      metadata: {
        model: 'model-a',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 20,
      },
    }));

    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      serviceRegistry: createWyomingServiceRegistry([
        createWyomingHandleServiceAdapter({ handleMessage }),
      ]),
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
    });

    const transportSession = createTransportSession('conn-7');
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-service' },
    });
    emitted.length = 0;

    await runtime.handleFrame(transportSession, {
      type: 'transcript',
      data: {
        session_id: 'session-service',
        text: 'hello',
      },
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'handled',
        data: expect.objectContaining({
          session_id: 'session-service',
          text: 'handled response',
        }),
      }),
    ]);
  });

  it('returns deterministic not_supported errors for disabled service families', async () => {
    const emitted: WyomingFrame[] = [];
    const runtime = new WyomingRuntime({
      info: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
      serviceRegistry: createWyomingServiceRegistry([
        createWyomingHandleServiceAdapter({
          handleMessage: vi.fn(async () => ({
            content: 'noop',
            channelId: 'api:wyoming:unknown:conn-8',
            metadata: {
              model: 'model-b',
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 1,
            },
          })),
        }),
      ]),
      emitFrame: async (_session, frame) => {
        emitted.push(frame);
      },
    });

    const transportSession = createTransportSession('conn-8');
    await runtime.handleFrame(transportSession, {
      type: 'session.start',
      data: { session_id: 'session-tts-disabled' },
    });
    emitted.length = 0;

    await runtime.handleFrame(transportSession, {
      type: 'synthesize',
      data: {
        session_id: 'session-tts-disabled',
        text: 'hello world',
      },
    });

    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          code: 'not_supported',
          service: 'tts',
        }),
      }),
    ]);
  });
});
