import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  createInitialHubStreamState,
  reduceHubStreamState,
  type HubStreamState,
} from '../lib/stream/hub-stream.js';
import { useVoicePlayback } from './use-voice-playback.js';

const AT = '2026-08-30T00:00:00.000Z';

class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  readonly stop = vi.fn(() => this.onended?.());
  connect(): void {}
  start(): void {}
}

const sources: FakeBufferSource[] = [];

class FakeAudioContext {
  readonly destination = { connect: () => undefined };
  readonly resume = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);

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
    sources.push(source);
    return source;
  }
}

function stateWithQueuedAudio(): HubStreamState {
  let state = reduceHubStreamState(createInitialHubStreamState(AT), {
    type: 'client.session',
    at: AT,
    session: { capabilities: { output: ['streamed_audio'] } },
  });
  for (const message of [
    { type: 'text', data: 'audio-init' },
    { type: 'audio', data: 'AQID' },
    { type: 'text', data: 'audio-end' },
  ] as const) {
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: AT,
      event: { message },
    });
  }
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sources.length = 0;
});

describe('useVoicePlayback interruption bridge', () => {
  it.each([
    ['assistant.interrupted', (state: HubStreamState) => reduceHubStreamState(state, {
      type: 'hub.inbound' as const,
      at: AT,
      event: { message: { type: 'assistant.interrupted' as const, sessionId: 'browser-session-1' } },
    })],
    ['pause-audio', (state: HubStreamState) => reduceHubStreamState(state, {
      type: 'hub.inbound' as const,
      at: AT,
      event: { message: { type: 'action' as const, data: 'pause-audio' as const } },
    })],
    ['authority loss', (state: HubStreamState) => reduceHubStreamState(state, {
      type: 'client.state' as const,
      at: AT,
      event: { previous: 'ready' as const, current: 'closed' as const },
    })],
  ])('stops in-flight playback and closes the mouth on %s', async (_label, interrupt) => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const store = { consumeVoiceUtterance: vi.fn() };
    const initial = stateWithQueuedAudio();
    const { result, rerender, unmount } = renderHook(
      ({ state }) => useVoicePlayback(state.voicePlayback, store as never),
      { initialProps: { state: initial } },
    );

    await waitFor(() => expect(sources).toHaveLength(1));
    await waitFor(() => expect(result.current.active).toBe(true));
    await waitFor(() => expect(result.current.mouthOpen).toBe(true));
    const playing = sources[0]!;

    rerender({ state: interrupt(initial) });

    await waitFor(() => expect(playing.stop).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toEqual({ active: false, mouthOpen: false }));
    unmount();
  });
});
