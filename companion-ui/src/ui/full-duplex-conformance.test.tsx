import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionGatewayClient } from '../lib/api/gateway-client.js';
import type { SatelliteHubWebSocketLike } from '../lib/api/client.js';
import { BrowserMicrophoneCapture, type BrowserMicrophoneOpener } from '../lib/audio/browser-microphone.js';
import { HubStreamStore } from '../lib/stream/hub-stream.js';
import { shouldInterruptForMicrophoneSpeech, useBrowserMicrophone } from './use-browser-microphone.js';
import { useVoicePlayback } from './use-voice-playback.js';

class FakeSocket implements SatelliteHubWebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close');
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  message(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) });
  }

  private dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  readonly stop = vi.fn(() => this.onended?.());
  connect(): void {}
  start(): void {}
}

const audioSources: FakeBufferSource[] = [];

class FakeAudioContext {
  readonly destination = { connect: () => undefined };
  async resume(): Promise<void> {}
  async close(): Promise<void> {}

  async decodeAudioData(): Promise<{
    sampleRate: number;
    length: number;
    getChannelData(channel: number): Float32Array;
    copyToChannel(source: Float32Array, channel: number): void;
  }> {
    const samples = new Float32Array(9_600).fill(0.8);
    return {
      sampleRate: 48_000,
      length: samples.length,
      getChannelData: () => samples,
      copyToChannel: () => undefined,
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return {
      sampleRate,
      length,
      getChannelData: () => samples,
      copyToChannel: (source: Float32Array) => samples.set(source),
    };
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    audioSources.push(source);
    return source;
  }
}

function jsonFrames(socket: FakeSocket): unknown[] {
  return socket.sent
    .filter((frame): frame is string => typeof frame === 'string')
    .map(frame => JSON.parse(frame) as unknown);
}

function useFullDuplexClient(
  store: HubStreamStore,
  openMicrophone: BrowserMicrophoneOpener,
  wakeLock: { supported(): boolean; acquire(): Promise<void>; release(): Promise<void> },
) {
  const [stream, setStream] = useState(() => store.snapshot());
  useEffect(() => store.subscribe(setStream), [store]);
  const microphone = useBrowserMicrophone({
    start: () => store.startPcmAudioStream(),
    write: pcm => store.sendPcmAudio(pcm),
    stop: () => store.stopPcmAudioStream(),
  }, {
    supported: true,
    createCapture: onFailure => new BrowserMicrophoneCapture({
      start: () => store.startPcmAudioStream(),
      write: pcm => store.sendPcmAudio(pcm),
      stop: () => store.stopPcmAudioStream(),
    }, { openMicrophone, onFailure }),
    createWakeLock: () => wakeLock,
  });
  const playback = useVoicePlayback(stream.voicePlayback, store);
  const lastInterruptedLiveUserId = useRef<string | null>(null);

  useEffect(() => {
    const liveUserId = stream.liveUser?.id ?? null;
    if (!liveUserId) {
      lastInterruptedLiveUserId.current = null;
      return;
    }
    if (!shouldInterruptForMicrophoneSpeech({
      captureActive: microphone.state.phase === 'active',
      companionTalking: playback.active,
      liveUserId,
      lastInterruptedLiveUserId: lastInterruptedLiveUserId.current,
    })) return;
    lastInterruptedLiveUserId.current = liveUserId;
    store.interrupt();
  }, [microphone.state.phase, playback.active, store, stream.liveUser]);

  return { microphone, playback, stream };
}

afterEach(() => {
  vi.unstubAllGlobals();
  audioSources.length = 0;
});

describe('Companion full-duplex voice conformance', () => {
  it('negotiates both directions and barges into active streamed playback from hands-free speech', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const socket = new FakeSocket();
    const client = new CompanionGatewayClient({
      url: 'wss://fleet.example.test/companion-ui/companions/11111111-1111-4111-8111-111111111111/ws',
      webSocketFactory: () => socket,
      requestIdFactory: () => 'audio-request-1',
    });
    const store = new HubStreamStore(client);
    let emitPcm: ((chunk: Uint8Array) => void) | null = null;
    const openMicrophone: BrowserMicrophoneOpener = async (options) => {
      emitPcm = options.pcm;
      return { activate: () => undefined, close: async () => undefined };
    };
    const wakeLock = {
      supported: () => true,
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const { result, unmount } = renderHook(() => useFullDuplexClient(store, openMicrophone, wakeLock));

    await act(async () => {
      const connecting = store.connect();
      socket.open();
      socket.message({
        schemaVersion: 1,
        type: 'session.ready',
        device: { id: 'phone', label: 'Phone' },
        place: { id: 'office', label: 'Office' },
        capabilities: ['text', 'audio_input', 'audio_output', 'speech_to_text'],
        telemetryScopes: ['status'],
        eventCapabilities: [],
      });
      await connecting;
    });
    expect(result.current.stream.session?.capabilities).toMatchObject({
      input: ['text', 'microphone_pcm', 'final_transcript'],
      output: ['text', 'streamed_audio'],
    });

    let starting: Promise<void> | undefined;
    act(() => {
      starting = result.current.microphone.startFromUserGesture({ handsFree: true });
    });
    await waitFor(() => expect(jsonFrames(socket)).toContainEqual({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'audio-request-1',
    }));
    await act(async () => {
      socket.message({ schemaVersion: 1, type: 'audio.ready', requestId: 'audio-request-1' });
      await starting;
    });
    expect(result.current.microphone.state).toMatchObject({
      phase: 'active', handsFree: true, wakeLockHeld: true,
    });
    expect(wakeLock.acquire).toHaveBeenCalledTimes(1);

    act(() => emitPcm?.(new Uint8Array(640)));
    await waitFor(() => expect(socket.sent.some(frame => frame instanceof Uint8Array)).toBe(true));
    await act(async () => {
      socket.message({
        schemaVersion: 1,
        type: 'audio.ack',
        requestId: 'audio-request-1',
        sequence: 0,
      });
      socket.message({
        schemaVersion: 1,
        type: 'audio.turn.started',
        requestId: 'audio-request-1',
      });
    });

    await act(async () => {
      for (const event of [
        { type: 'text', data: 'audio-init' },
        { type: 'audio', data: 'AQID' },
        { type: 'text', data: 'audio-end' },
      ]) {
        socket.message({ schemaVersion: 1, type: 'event', event });
      }
    });
    await waitFor(() => expect(result.current.playback.active).toBe(true));
    await waitFor(() => expect(result.current.playback.mouthOpen).toBe(true));

    await act(async () => {
      socket.message({
        schemaVersion: 1,
        type: 'event',
        event: { type: 'message', data: { role: 'user', content: 'hello', live: true } },
      });
    });
    await waitFor(() => expect(jsonFrames(socket)).toContainEqual({
      schemaVersion: 1,
      type: 'audio.interrupt',
      requestId: 'audio-request-1',
    }));

    await act(async () => {
      socket.message({
        schemaVersion: 1,
        type: 'event',
        event: { type: 'action', data: 'pause-audio' },
      });
    });
    await waitFor(() => expect(audioSources[0]?.stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.playback).toEqual({ active: false, mouthOpen: false }));

    let stopping: Promise<void> | undefined;
    act(() => { stopping = result.current.microphone.stop(); });
    await waitFor(() => expect(jsonFrames(socket)).toContainEqual({
      schemaVersion: 1,
      type: 'audio.stop',
      requestId: 'audio-request-1',
    }));
    await act(async () => {
      socket.message({ schemaVersion: 1, type: 'audio.stopped', requestId: 'audio-request-1' });
      await stopping;
    });
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
    expect(result.current.microphone.state.phase).toBe('idle');

    unmount();
    store.destroy();
    client.disconnect();
  });
});
