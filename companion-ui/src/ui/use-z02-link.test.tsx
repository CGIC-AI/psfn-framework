import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Z02LinkConnection,
  Z02LinkConnector,
  Z02LinkProgress,
} from '../lib/z02/web-bluetooth.js';
import { useZ02Link } from './use-z02-link.js';

describe('useZ02Link', () => {
  it('reports stock PCM receipt from the badge', async () => {
    const disconnect = vi.fn();
    const relay = {
      start: vi.fn(async () => undefined),
      write: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    let emitPcm: ((pcm: Uint8Array) => void) | undefined;
    let remoteDisconnect: (() => void) | null = null;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        remoteDisconnect = callbacks.disconnected;
        emitPcm = callbacks.audioPcm;
        for (const phase of ['selecting', 'connecting', 'authenticating', 'subscribing'] as Z02LinkProgress[]) {
          callbacks.progress?.(phase);
        }
        await callbacks.prepareAudio?.();
        return {
          deviceName: 'Z02 Test Badge',
          disconnect,
          microphone: 'pcm16-16khz',
          transport: 'stock-rcsp',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector, { audioRelay: relay }));

    expect(result.current.state.phase).toBe('idle');
    await act(async () => { await result.current.link(); });
    expect(result.current.state).toMatchObject({
      phase: 'linked',
      deviceName: 'Z02 Test Badge',
      audioFrames: 0,
      microphone: 'pcm16-16khz',
      transport: 'stock-rcsp',
    });

    act(() => { emitPcm?.(Uint8Array.of(0x00, 0x01)); });
    expect(result.current.state).toMatchObject({ audioFrames: 1, decodedFrames: 1 });
    expect(relay.start).toHaveBeenCalledOnce();
    expect(relay.write).toHaveBeenCalledWith(Uint8Array.of(0x00, 0x01));
    expect(result.current.state).toMatchObject({ relayedFrames: 1 });
    expect(result.current.state.detail).toContain('Relayed 1 PCM chunk');

    act(() => { remoteDisconnect?.(); });
    expect(result.current.state).toMatchObject({ phase: 'idle', detail: 'Badge disconnected.' });
    expect(relay.stop).toHaveBeenCalledOnce();

    act(() => { result.current.disconnect(); });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('surfaces a non-fatal badge audio stream error while keeping the link visible', async () => {
    let emitError: ((error: Error) => void) | undefined;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        emitError = callbacks.error;
        return {
          deviceName: 'Z02 Test Badge',
          disconnect: vi.fn(),
          microphone: 'pcm16-16khz',
          transport: 'stock-rcsp',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });
    act(() => { emitError?.(new Error('raw implementation detail')); });

    expect(result.current.state).toMatchObject({
      phase: 'linked',
      audioError: 'The badge audio stream reported an error.',
      detail: 'The badge audio stream reported an error.',
    });
  });

  it('decodes Stark Ruby Omi frames to PCM through the live WebCodecs seam', async () => {
    const decode = vi.fn();
    const close = vi.fn();
    const relay = {
      start: vi.fn(async () => undefined),
      write: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    let emitAudio: ((frame: {
      firstSequence: number;
      lastSequence: number;
      opus: Uint8Array;
    }) => void) | undefined;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        emitAudio = callbacks.audioFrame;
        await callbacks.prepareAudio?.();
        return {
          deviceName: 'Omi',
          disconnect: vi.fn(),
          microphone: 'opus-16khz',
          transport: 'omi-audio',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector, {
      audioRelay: relay,
      createOmiDecoder: callbacks => ({
        close,
        decode(opus) {
          decode(opus);
          callbacks.pcm({
            pcm: Uint8Array.of(0x00, 0x01),
            sampleRateHz: 16_000,
            channels: 1,
            timestampUs: 0,
          });
        },
      }),
    }));

    await act(async () => { await result.current.link(); });
    expect(result.current.state).toMatchObject({
      phase: 'linked',
      audioFrames: 0,
      microphone: 'opus-16khz',
      transport: 'omi-audio',
    });

    act(() => emitAudio?.({ firstSequence: 0, lastSequence: 0, opus: Uint8Array.of(0xaa) }));
    expect(decode).toHaveBeenCalledWith(Uint8Array.of(0xaa));
    expect(result.current.state).toMatchObject({ audioFrames: 1, decodedFrames: 1 });
    expect(relay.write).toHaveBeenCalledWith(Uint8Array.of(0x00, 0x01));
    expect(result.current.state).toMatchObject({ relayedFrames: 1 });
    expect(result.current.state.detail).toContain('decoded to PCM');

    act(() => { result.current.disconnect(); });
    expect(close).toHaveBeenCalledOnce();
  });

  it('shows a safe retry state after authentication failure', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async () => { throw new Error('Z02 authentication failed'); }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({
      phase: 'error',
      detail: 'The badge rejected stock authentication.',
    });
  });

  it('preserves an authentication-time disconnect as the visible reason', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        callbacks.disconnected();
        throw new Error('Z02 link failed');
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({ phase: 'idle', detail: 'Badge disconnected.' });
  });

  it('turns transport timeouts into a useful non-secret retry state', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async () => { throw new Error('Z02 notification subscription timed out'); }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({
      phase: 'error',
      detail: 'The badge stopped responding before the link completed. Tap Link Z02 to retry.',
    });
  });

  it('reports unsupported browsers without starting discovery', async () => {
    const { result } = renderHook(() => useZ02Link(null));

    await act(async () => { await result.current.link(); });

    expect(result.current.state.phase).toBe('unsupported');
  });
});
