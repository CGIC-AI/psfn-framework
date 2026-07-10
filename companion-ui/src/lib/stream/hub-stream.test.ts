import { describe, expect, it, vi } from 'vitest';
import type {
  SatelliteHubClientEventMap,
  SatelliteHubSnapshot,
} from '../api/client.js';
import { buildSatelliteHello } from '../api/auth.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  reduceHubStreamState,
  type HubStreamClientLike,
} from './hub-stream.js';

describe('hub stream reducer', () => {
  it('preserves event order and session correlation', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');

    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'session.ready',
          sessionId: 'session-1',
          channelId: 'satellite.endpoint:session-1',
          deviceId: 'phone',
          deviceName: 'Phone',
          satelliteId: 'phone',
          audioFormat: 'text',
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:02.000Z',
      event: {
        message: {
          type: 'message',
          data: { role: 'user', content: 'hello', final: true },
        },
      },
    });

    expect(state.connection).toBe('ready');
    expect(state.events.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(state.events[1]?.sessionId).toBe('session-1');
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      content: 'hello',
      sessionId: 'session-1',
      channelId: 'satellite.endpoint:session-1',
    });
  });

  it('accumulates assistant live deltas and clears them on final text', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = {
      ...state,
      session: {
        deviceId: 'phone',
        deviceName: 'Phone',
        satelliteId: 'phone',
        satelliteName: 'Phone',
        sessionId: 'session-1',
        channelId: 'satellite.endpoint:session-1',
      },
    };

    for (const [index, content] of ['I am ', 'here.'].entries()) {
      state = reduceHubStreamState(state, {
        type: 'hub.inbound',
        at: `2026-06-17T00:00:0${index + 1}.000Z`,
        event: {
          message: {
            type: 'message',
            data: { role: 'assistant', content, live: true },
          },
        },
      });
    }

    expect(state.liveAssistant?.content).toBe('I am here.');
    expect(state.phase).toBe('responding');

    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'message',
          data: { role: 'assistant', content: 'I am here.', final: true },
        },
      },
    });

    expect(state.liveAssistant).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'I am here.',
      final: true,
    });
  });

  it('surfaces disconnects and failures honestly', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'client.state',
      at: '2026-06-17T00:00:01.000Z',
      event: { previous: 'ready', current: 'closed' },
    });

    expect(state.connection).toBe('disconnected');

    state = reduceHubStreamState(state, {
      type: 'client.error',
      at: '2026-06-17T00:00:02.000Z',
      event: { message: 'protocol violation', recoverable: false },
    });

    expect(state.connection).toBe('failed');
    expect(state.phase).toBe('failed');
    expect(state.failure?.message).toBe('protocol violation');
  });
});

describe('hub stream store', () => {
  it('wires client events into subscribers', () => {
    const client = new FakeHubClient();
    const store = new HubStreamStore(client, createInitialHubStreamState('2026-06-17T00:00:00.000Z'), fixedClock);
    const snapshots: string[] = [];
    store.subscribe((state) => snapshots.push(`${state.connection}:${state.sequence}`));

    client.emit('state', { previous: 'idle', current: 'connecting' });
    client.emit('inbound', {
      message: {
        type: 'message',
        data: { role: 'assistant', content: 'hello', final: true },
      },
    });

    expect(snapshots).toEqual(['idle:0', 'connecting:0', 'connecting:1']);
    expect(store.snapshot().messages[0]?.content).toBe('hello');

    store.destroy();
    client.emit('state', { previous: 'connecting', current: 'closed' });
    expect(snapshots).toEqual(['idle:0', 'connecting:0', 'connecting:1']);
  });
});

describe('hub stream store control + artifact wiring', () => {
  it('relays approval decisions through the client transport', () => {
    const client = new FakeHubClient();
    const spy = vi.spyOn(client, 'sendApprovalDecision');
    const store = new HubStreamStore(client, createInitialHubStreamState('2026-06-17T00:00:00.000Z'), fixedClock);

    store.submitApprovalDecision('ap-1', 'approve');

    expect(spy).toHaveBeenCalledWith('ap-1', 'approve');
    store.destroy();
  });

  it('mints a request id, sends a preview request, and ages it out on timeout', () => {
    const client = new FakeHubClient();
    const sendSpy = vi.spyOn(client, 'sendArtifactPreviewRequest');
    const holder: { scheduled: (() => void) | null } = { scheduled: null };
    const store = new HubStreamStore(client, createInitialHubStreamState('2026-06-17T00:00:00.000Z'), {
      clock: () => new Date('2026-06-17T00:00:09.000Z'),
      requestIdFactory: () => 'req-fixed',
      scheduleTimeout: (cb) => {
        holder.scheduled = cb;
        return 1;
      },
      cancelTimeout: () => undefined,
    });

    // Seed an artifact so the shelf has something to correlate against.
    client.emit('inbound', {
      message: {
        type: 'artifact.created',
        data: {
          id: 'art-1',
          label: 'Report',
          mediaType: 'image/png',
          provenance: 'tool:renderer',
          createdAt: '2026-06-17T00:00:01.000Z',
          previewable: true,
        },
      },
    });

    store.requestArtifactPreview('art-1');
    expect(sendSpy).toHaveBeenCalledWith('req-fixed', 'art-1');
    expect(store.snapshot().artifactPreviews['art-1']).toMatchObject({ status: 'loading', requestId: 'req-fixed' });

    expect(holder.scheduled).not.toBeNull();
    holder.scheduled?.();
    expect(store.snapshot().artifactPreviews['art-1']).toMatchObject({ status: 'error', message: 'Preview timed out' });

    store.destroy();
  });

  it('cancels the preview timeout once a correlated result arrives', () => {
    const client = new FakeHubClient();
    const cancelSpy = vi.fn();
    const store = new HubStreamStore(client, createInitialHubStreamState('2026-06-17T00:00:00.000Z'), {
      clock: () => new Date('2026-06-17T00:00:09.000Z'),
      requestIdFactory: () => 'req-fixed',
      scheduleTimeout: () => 7,
      cancelTimeout: cancelSpy,
    });

    client.emit('inbound', {
      message: {
        type: 'artifact.created',
        data: {
          id: 'art-1',
          label: 'Report',
          mediaType: 'image/png',
          provenance: 'tool:renderer',
          createdAt: '2026-06-17T00:00:01.000Z',
          previewable: true,
        },
      },
    });
    store.requestArtifactPreview('art-1');
    client.emit('inbound', {
      message: {
        type: 'artifact.preview.result',
        requestId: 'req-fixed',
        artifactId: 'art-1',
        mediaType: 'image/png',
        data: 'aGVsbG8=',
      },
    });

    expect(cancelSpy).toHaveBeenCalledWith(7);
    expect(store.snapshot().artifactPreviews['art-1']).toMatchObject({ status: 'ready' });
    store.destroy();
  });
});

class FakeHubClient implements HubStreamClientLike {
  private readonly listeners = new Map<keyof SatelliteHubClientEventMap, Set<(event: never) => void>>();
  private readonly hello = buildSatelliteHello();

  on<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    listener: (event: SatelliteHubClientEventMap[K]) => void,
  ): () => void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: never) => void);
    return () => {
      listeners?.delete(listener as (event: never) => void);
    };
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    this.emit('state', { previous: 'ready', current: 'closed' });
  }

  sendUserText(): void {
    return;
  }

  interrupt(): void {
    return;
  }

  sendApprovalDecision(): void {
    return;
  }

  sendArtifactPreviewRequest(): void {
    return;
  }

  snapshot(): SatelliteHubSnapshot {
    return {
      state: 'idle',
      ready: false,
      url: 'ws://hub.local:8787/',
      hello: this.hello,
      session: {
        deviceId: this.hello.deviceId,
        deviceName: this.hello.deviceName,
        satelliteId: this.hello.satelliteId ?? this.hello.deviceId,
        satelliteName: this.hello.satelliteName ?? this.hello.deviceName,
      },
    };
  }

  emit<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    event: SatelliteHubClientEventMap[K],
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

function fixedClock(): Date {
  return new Date('2026-06-17T00:00:09.000Z');
}
