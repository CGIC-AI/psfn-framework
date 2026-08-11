import { describe, expect, it, vi } from 'vitest';
import type {
  SatelliteHubClientEventMap,
  SatelliteHubSnapshot,
} from '../api/client.js';
import { buildSatelliteHello } from '../api/auth.js';
import type { HubToClientMessage } from '../protocol/events.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  reduceHubStreamState,
  type HubStreamClientLike,
  type HubStreamState,
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

  it('stores an ordinary v1 approval.requested with no v2 fields', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-1',
            title: 'Write file',
            requestedAt: '2026-06-17T00:00:01.000Z',
            redactedContext: 'ctx',
            status: 'pending',
          },
        },
      },
    });
    expect(state.approvals).toHaveLength(1);
    const entry = state.approvals[0];
    if (!entry) throw new Error('missing approval entry');
    expect(entry).toMatchObject({ id: 'ap-1', status: 'pending' });
    expect(entry.sourceSystem).toBeUndefined();
    expect(entry.attribution).toBeUndefined();
    expect(entry.grantMode).toBeUndefined();
  });

  it('passes v2 attribution/grant fields through and drops unknown future keys', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-2',
            title: 'send email',
            requestedAt: '2026-06-17T00:00:01.000Z',
            redactedContext: 'ctx',
            status: 'pending',
            sourceSystem: 'shard',
            attribution: { parentId: 'companion-1', parentLabel: 'Parent', shardId: 'shard-1', shardLabel: 'Shard' },
            action: 'send email',
            scope: 'outbound',
            reason: 'ctx',
            grantMode: { kind: 'once' },
            // a tolerated-but-unknown key must not enter store state
            futureField: 'ignore me',
          } as never,
        },
      },
    });
    const entry = state.approvals[0];
    if (!entry) throw new Error('missing approval entry');
    expect(entry.sourceSystem).toBe('shard');
    expect(entry.attribution).toEqual({
      parentId: 'companion-1',
      parentLabel: 'Parent',
      shardId: 'shard-1',
      shardLabel: 'Shard',
    });
    expect(entry.action).toBe('send email');
    expect(entry.grantMode).toEqual({ kind: 'once' });
    expect(entry).not.toHaveProperty('futureField');
  });

  it('does not resurrect a terminal approval when its request frame is replayed', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-replay',
            title: 'Original request',
            requestedAt: '2026-06-17T00:00:01.000Z',
            redactedContext: 'Original context',
            status: 'pending',
          },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:02.000Z',
      event: {
        message: {
          type: 'approval.resolved',
          data: {
            id: 'ap-replay',
            status: 'approved',
            resolvedAt: '2026-06-17T00:00:02.000Z',
          },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-replay',
            title: 'Replayed request',
            requestedAt: '2026-06-17T00:00:01.000Z',
            redactedContext: 'Replayed context',
            status: 'pending',
          },
        },
      },
    });

    expect(state.approvals).toEqual([expect.objectContaining({
      id: 'ap-replay',
      title: 'Original request',
      status: 'approved',
      resolvedAt: '2026-06-17T00:00:02.000Z',
    })]);
  });

  it('does not extend or replace a pending approval when its immutable id is replayed', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-pending-replay',
            title: 'Original request',
            requestedAt: '2026-06-17T00:00:01.000Z',
            expiresAt: '2026-06-17T00:00:02.000Z',
            redactedContext: 'Original context',
            status: 'pending',
          },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-pending-replay',
            title: 'Replacement request',
            requestedAt: '2026-06-17T00:00:03.000Z',
            expiresAt: '2026-06-17T01:00:00.000Z',
            redactedContext: 'Replacement context',
            status: 'pending',
          },
        },
      },
    });

    expect(state.approvals).toEqual([expect.objectContaining({
      id: 'ap-pending-replay',
      title: 'Original request',
      requestedAt: '2026-06-17T00:00:01.000Z',
      expiresAt: '2026-06-17T00:00:02.000Z',
      redactedContext: 'Original context',
      status: 'pending',
    })]);
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

  it('replaces cumulative live microphone transcripts and commits only the final turn', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');

    for (const [index, content] of ['hello', 'hello there'].entries()) {
      state = reduceHubStreamState(state, {
        type: 'hub.inbound',
        at: `2026-06-17T00:00:0${index + 1}.000Z`,
        event: {
          message: {
            type: 'message',
            data: { role: 'user', content, live: true },
          },
        },
      });
    }

    expect(state.messages).toEqual([]);
    expect(state.liveUser?.content).toBe('hello there');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'message',
          data: { role: 'user', content: 'hello there', final: true },
        },
      },
    });

    expect(state.liveUser).toBeNull();
    expect(state.messages).toEqual([expect.objectContaining({
      role: 'user',
      content: 'hello there',
      final: true,
    })]);
  });

  it('surfaces disconnects and failures honestly', () => {
    let state: HubStreamState = {
      ...createInitialHubStreamState('2026-06-17T00:00:00.000Z'),
      session: { eventCapabilities: ['approvals.v2'] },
      approvals: [{
        id: 'approval-1',
        title: 'Approval',
        requestedAt: '2026-06-17T00:00:00.000Z',
        redactedContext: 'Context',
        status: 'pending' as const,
      }],
      approvalResolutions: {
        'approval-old': {
          status: 'denied' as const,
          resolvedAt: '2026-06-17T00:00:00.000Z',
        },
      },
    };
    state = reduceHubStreamState(state, {
      type: 'client.state',
      at: '2026-06-17T00:00:01.000Z',
      event: { previous: 'ready', current: 'closed' },
    });

    expect(state.connection).toBe('disconnected');
    expect(state.session).toBeNull();
    expect(state.approvals).toEqual([]);
    expect(state.approvalResolutions).toEqual({});

    state = reduceHubStreamState(state, {
      type: 'client.error',
      at: '2026-06-17T00:00:02.000Z',
      event: { message: 'protocol violation', recoverable: false },
    });

    expect(state.connection).toBe('failed');
    expect(state.phase).toBe('failed');
    expect(state.failure?.message).toBe('protocol violation');
  });

  it('retains only the latest emotion snapshot as current affect', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    expect(state.emotion).toBeNull();

    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'emotion.snapshot',
          data: {
            trigger: 'post_turn',
            vad: { valence: 0.1, arousal: 0.1, dominance: 0 },
            mood: { valence: 0, arousal: 0, dominance: 0 },
            discrete: [{ label: 'joy', score: 0.6 }],
            confidence: 0.5,
            timestamp: '2026-06-17T00:00:01.000Z',
          },
        },
      },
    });
    expect(state.emotion?.trigger).toBe('post_turn');
    expect(state.emotion?.receivedAt).toBe('2026-06-17T00:00:01.000Z');

    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:02.000Z',
      event: {
        message: {
          type: 'emotion.snapshot',
          data: {
            trigger: 'vad_shift',
            vad: { valence: -0.8, arousal: 0.7, dominance: -0.5 },
            mood: { valence: -0.2, arousal: 0.1, dominance: 0 },
            discrete: [],
            confidence: 0.9,
            acacAxes: [{ axis: 'agency', score: 0.3 }],
            timestamp: '2026-06-17T00:00:02.000Z',
          },
        },
      },
    });
    // Newest replaces the previous snapshot (state projection, not a log).
    expect(state.emotion?.trigger).toBe('vad_shift');
    expect(state.emotion?.vad.valence).toBe(-0.8);
    expect(state.emotion?.acacAxes).toEqual([{ axis: 'agency', score: 0.3 }]);
  });

  it('clears emotion affect when connection authority is lost', () => {
    let state: HubStreamState = {
      ...createInitialHubStreamState('2026-06-17T00:00:00.000Z'),
      emotion: {
        trigger: 'post_turn',
        vad: { valence: 0.5, arousal: 0.5, dominance: 0 },
        mood: { valence: 0, arousal: 0, dominance: 0 },
        discrete: [],
        confidence: 0.5,
        timestamp: '2026-06-17T00:00:00.000Z',
        sequence: 1,
        receivedAt: '2026-06-17T00:00:00.000Z',
      },
    };
    state = reduceHubStreamState(state, {
      type: 'client.state',
      at: '2026-06-17T00:00:01.000Z',
      event: { previous: 'ready', current: 'closed' },
    });
    expect(state.emotion).toBeNull();
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
  it('relays PCM stream lifecycle through the active gateway transport', async () => {
    const client = new FakeHubClient();
    const start = vi.spyOn(client.pcmAudio, 'start');
    const send = vi.spyOn(client.pcmAudio, 'write');
    const stop = vi.spyOn(client.pcmAudio, 'stop');
    const store = new HubStreamStore(client);
    const pcm = Uint8Array.of(0x00, 0x01);

    await store.startPcmAudioStream();
    await store.sendPcmAudio(pcm);
    await store.stopPcmAudioStream();

    expect(start).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(pcm);
    expect(stop).toHaveBeenCalledOnce();
    store.destroy();
  });

  it('relays a coalesced headpat through the client transport', () => {
    const client = new FakeHubClient();
    const spy = vi.spyOn(client, 'sendTouchInteraction');
    const store = new HubStreamStore(client);
    const interaction = { kind: 'headpat', region: 'head', count: 12, durationMs: 1_100 } as const;

    store.sendTouchInteraction(interaction);

    expect(spy).toHaveBeenCalledWith(interaction);
    store.destroy();
  });

  it('relays a device.location sample through a coordinate-terminating transport', () => {
    const client = new FakeHubClient();
    const spy = vi.spyOn(client, 'sendDeviceLocation');
    const store = new HubStreamStore(client);
    const sample = { lat: 37.42, lon: -122.08, accuracyM: 12, timestamp: 1_700_000_000_000 };

    expect(store.canSendDeviceLocation()).toBe(true);
    store.sendDeviceLocation(sample);

    expect(spy).toHaveBeenCalledWith(sample);
    store.destroy();
  });

  it('reports device.location as unavailable when the transport cannot terminate coordinates', () => {
    const client = new FakeHubClient();
    vi.spyOn(client, 'supportsDeviceLocation').mockReturnValue(false);
    const store = new HubStreamStore(client);

    expect(store.canSendDeviceLocation()).toBe(false);
    store.destroy();
  });

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
  readonly pcmAudio = {
    start: () => Promise.resolve(),
    write: (_pcm: Uint8Array) => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
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

  sendTouchInteraction(): void {
    return;
  }

  supportsDeviceLocation(): boolean {
    return true;
  }

  sendDeviceLocation(): void {
    return;
  }

  snapshot(): SatelliteHubSnapshot {
    return {
      state: 'idle',
      ready: false,
      url: 'ws://hub.local:8787/',
      hello: this.hello,
      session: {},
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

describe('hub stream voice playback wiring', () => {
  const AUDIO_CHUNK = 'AAAA';

  function withStreamedAudio(at: string): HubStreamState {
    return reduceHubStreamState(createInitialHubStreamState(at), {
      type: 'client.session',
      at,
      session: { capabilities: { output: ['text', 'streamed_audio'] } },
    });
  }

  function inbound(state: HubStreamState, message: HubToClientMessage, at: string): HubStreamState {
    return reduceHubStreamState(state, { type: 'hub.inbound', at, event: { message } });
  }

  it('reassembles bracketed audio frames when the session advertises streamed_audio', () => {
    let state = withStreamedAudio('2026-07-22T00:00:00.000Z');
    expect(state.voicePlayback.supported).toBe(true);
    state = inbound(state, { type: 'text', data: 'audio-init' }, '2026-07-22T00:00:01.000Z');
    state = inbound(state, { type: 'audio', data: AUDIO_CHUNK }, '2026-07-22T00:00:02.000Z');
    state = inbound(state, { type: 'text', data: 'audio-end' }, '2026-07-22T00:00:03.000Z');
    expect(state.voicePlayback.queue).toHaveLength(1);
    expect(state.voicePlayback.queue[0]?.chunksBase64).toEqual([AUDIO_CHUNK]);
  });

  it('drops audio and does not buffer without the streamed_audio ceiling', () => {
    let state = createInitialHubStreamState('2026-07-22T00:00:00.000Z');
    expect(state.voicePlayback.supported).toBe(false);
    state = inbound(state, { type: 'text', data: 'audio-init' }, '2026-07-22T00:00:01.000Z');
    state = inbound(state, { type: 'audio', data: AUDIO_CHUNK }, '2026-07-22T00:00:02.000Z');
    expect(state.voicePlayback.queue).toHaveLength(0);
    expect(state.voicePlayback.bracketOpen).toBe(false);
    expect(state.voicePlayback.droppedFrames).toBeGreaterThan(0);
  });

  it('leaves ordinary caption text frames untouched', () => {
    let state = withStreamedAudio('2026-07-22T00:00:00.000Z');
    state = inbound(state, { type: 'text', data: 'a subtitle line' }, '2026-07-22T00:00:01.000Z');
    expect(state.voicePlayback.bracketOpen).toBe(false);
    expect(state.voicePlayback.droppedFrames).toBe(0);
  });

  it('clears buffered audio on an assistant interruption (barge-in)', () => {
    let state = withStreamedAudio('2026-07-22T00:00:00.000Z');
    state = inbound(state, { type: 'text', data: 'audio-init' }, '2026-07-22T00:00:01.000Z');
    state = inbound(state, { type: 'audio', data: AUDIO_CHUNK }, '2026-07-22T00:00:02.000Z');
    expect(state.voicePlayback.bracketOpen).toBe(true);
    state = inbound(state, { type: 'assistant.interrupted', sessionId: 's' }, '2026-07-22T00:00:03.000Z');
    expect(state.voicePlayback.bracketOpen).toBe(false);
    expect(state.voicePlayback.pending).toHaveLength(0);
  });

  it('resets playback support when authority is cleared', () => {
    let state = withStreamedAudio('2026-07-22T00:00:00.000Z');
    state = reduceHubStreamState(state, {
      type: 'client.state',
      at: '2026-07-22T00:00:04.000Z',
      event: { previous: 'ready', current: 'closed' },
    });
    expect(state.voicePlayback.supported).toBe(false);
  });

  it('consumes a delivered utterance through the store', () => {
    const client = new FakeHubClient();
    const store = new HubStreamStore(client);
    client.emit('session', { capabilities: { output: ['streamed_audio'] } });
    client.emit('inbound', { message: { type: 'text', data: 'audio-init' } });
    client.emit('inbound', { message: { type: 'audio', data: AUDIO_CHUNK } });
    client.emit('inbound', { message: { type: 'text', data: 'audio-end' } });
    const queued = store.snapshot().voicePlayback.queue;
    expect(queued).toHaveLength(1);
    store.consumeVoiceUtterance(queued[0]!.id);
    expect(store.snapshot().voicePlayback.queue).toHaveLength(0);
  });

});
